/**
 * Node SDK integration suite, run against a **live** BillKit API.
 *
 * Skipped entirely unless `BILLKIT_INTEGRATION_BASE_URL` is set, so
 * `make all-tests` on a laptop without a stack stays green. Boot one with
 * `make sdk-integration` (see `sdk/integration/SCENARIOS.md`).
 *
 * Every test is tagged with a scenario id from `sdk/integration/scenarios.json`,
 * and the final `describe` block asserts this suite covers **all** of them.
 * That assertion is what makes the parity matrix real: adding a scenario to
 * the manifest fails this suite until node implements it, and the python /
 * php suites carry the identical check.
 *
 * The unit suites (`tests/*.test.ts`) already cover transport, retry, and
 * error-mapping mechanics against a mock fetch. This suite deliberately does
 * *not* re-test those in isolation. It proves the SDK drives the real wire
 * contract: real cursor pagination, real idempotency records, and the real
 * money path through the fake Mollie provider.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BillKit } from "../../src/client.js";
import {
  AuthenticationError,
  ConflictError,
  InvalidRequestError,
  PermissionError,
  ResourceMissingError,
} from "../../src/errors.js";
import { verifyWebhookSignature, WebhookVerificationError } from "../../src/webhooks.js";
import {
  BASE_URL,
  deliverMollieWebhook,
  idemKey,
  INTEGRATION_ENABLED,
  mintScopedKey,
  mollie,
  provisionTenant,
  type TestTenant,
} from "./harness.js";
import { COVERED, assertManifestCoverage } from "./coverage.js";

const d = INTEGRATION_ENABLED ? describe : describe.skip;

/** Tag a test with its manifest scenario id and record the coverage. */
function scenario(id: string, name: string, fn: () => Promise<void>) {
  COVERED.add(id);
  return it(`[${id}] ${name}`, fn, 30_000);
}

let tenant: TestTenant;
let client: BillKit;

/** A product + price pair the money specs charge against. */
async function makePlan(
  c: BillKit,
  opts: {
    amountCents?: number;
    interval?: "month" | "year";
    trialDays?: number;
    usageType?: "licensed" | "metered";
  } = {},
) {
  const product = await c.products.create<{ id: string }>({ name: `Plan ${idemKey()}` });
  const price = await c.prices.create<{ id: string; amount_cents: number; usage_type: string }>({
    product_id: product.id,
    amount_cents: opts.amountCents ?? 2500,
    currency: "EUR",
    interval: opts.interval ?? "month",
    trial_days: opts.trialDays ?? 0,
    ...(opts.usageType === undefined ? {} : { usage_type: opts.usageType }),
  });
  return { product, price };
}

/**
 * Mint an ACTIVE subscription on `priceId` and return it.
 *
 * Same machinery as the money specs: checkout -> settle at the fake
 * Mollie -> deliver the webhook, then find the subscription by price.
 */
async function activeSubscription(c: BillKit, t: TestTenant, priceId: string) {
  await checkoutToActive(c, t, priceId);
  const subs = await c.subscriptions.list<{
    data: Array<{ id: string; status: string; price_id: string }>;
  }>({ limit: 100 });
  const sub = subs.data.find((s) => s.price_id === priceId);
  expect(sub, "a subscription should exist for the settled checkout").toBeTruthy();
  expect(sub!.status).toBe("active");
  return sub!;
}

/**
 * Take a checkout session all the way to an active subscription.
 *
 * Order matters and mirrors production: settle the payment at the provider
 * *first*, then deliver the webhook. The API re-fetches payment state from
 * the provider rather than trusting the webhook body, so a webhook delivered
 * before the settle would correctly observe `open` and do nothing.
 */
async function checkoutToActive(c: BillKit, t: TestTenant, priceId: string) {
  const session = await c.checkoutSessions.create<{ id: string; url: string }>({
    price_id: priceId,
    customer_email: `buyer-${idemKey()}@sdk-it.example.com`,
    success_url: "https://merchant.example.com/ok",
    cancel_url: "https://merchant.example.com/cancel",
  });
  const providerPaymentId = mollie.paymentIdFromCheckoutUrl(session.url);
  await mollie.settle(providerPaymentId, "paid");
  await deliverMollieWebhook(t.mollieRouteId, providerPaymentId);
  return { session, providerPaymentId };
}

d("BillKit node SDK against a live API", () => {
  beforeAll(async () => {
    tenant = await provisionTenant();
    client = new BillKit({ apiKey: tenant.apiKey, baseUrl: BASE_URL });
  });

  // ── auth ──────────────────────────────────────────────────────────

  describe("auth", () => {
    scenario("auth.valid_key", "a provisioned key reaches a real resource", async () => {
      const page = await client.products.list<{ object: string; data: unknown[] }>();
      expect(page.object).toBe("list");
      expect(Array.isArray(page.data)).toBe(true);
    });

    scenario("auth.bad_key", "an unknown key raises AuthenticationError", async () => {
      const bogus = new BillKit({
        apiKey: "bk_test_0000000000000000000000",
        baseUrl: BASE_URL,
      });
      await expect(bogus.products.list()).rejects.toBeInstanceOf(AuthenticationError);
    });

    scenario(
      "auth.scoped_key_denied",
      "a narrowly-scoped key raises PermissionError off-scope",
      async () => {
        // products:read only; customers is outside the grant.
        const secret = await mintScopedKey(tenant, ["products:read"]);
        const scoped = new BillKit({ apiKey: secret, baseUrl: BASE_URL });
        await expect(scoped.products.list()).resolves.toBeTruthy();
        await expect(scoped.customers.list()).rejects.toBeInstanceOf(PermissionError);
      },
    );
  });

  // ── crud ──────────────────────────────────────────────────────────

  describe("crud", () => {
    scenario("crud.product", "product round-trips", async () => {
      const created = await client.products.create<{ id: string; name: string }>({
        name: "Round Trip",
        description: "created by the node integration suite",
      });
      expect(created.id).toMatch(/^prod_/);

      const fetched = await client.products.retrieve<{ id: string; name: string }>(created.id);
      expect(fetched.name).toBe("Round Trip");

      const updated = await client.products.update<{ name: string }>(created.id, {
        name: "Round Trip v2",
      });
      expect(updated.name).toBe("Round Trip v2");

      // Archive is the update route: the product has no delete, because
      // an archived product stays readable.
      const archived = await client.products.update<{ active: boolean }>(created.id, {
        active: false,
      });
      expect(archived.active).toBe(false);
    });

    scenario("crud.price", "price creates under a product and filters by product_id", async () => {
      const { product, price } = await makePlan(client, { amountCents: 1234 });
      expect(price.amount_cents).toBe(1234);

      const fetched = await client.prices.retrieve<{ product_id: string }>(price.id);
      expect(fetched.product_id).toBe(product.id);

      const filtered = await client.prices.list<{ data: Array<{ id: string }> }>({
        product_id: product.id,
      });
      expect(filtered.data.map((p) => p.id)).toContain(price.id);
    });

    scenario("crud.price_archive", "archiving a price is a readable, repeatable no-op", async () => {
      const { product, price } = await makePlan(client, { amountCents: 777 });

      const archived = await client.prices.update<{ id: string; active: boolean }>(price.id, {
        active: false,
      });
      expect(archived.id).toBe(price.id);
      expect(archived.active).toBe(false);

      // Archiving is not a delete: the row survives, so a subscription
      // that still points at it can be read back rather than dangling.
      const fetched = await client.prices.retrieve<{ id: string; active: boolean }>(price.id);
      expect(fetched.active).toBe(false);
      const listed = await client.prices.list<{ data: Array<{ id: string }> }>({
        product_id: product.id,
      });
      expect(listed.data.map((p) => p.id)).toContain(price.id);

      // Re-archiving returns it unchanged instead of erroring, which is
      // what makes a retried archive safe.
      const again = await client.prices.update<{ id: string; active: boolean }>(price.id, {
        active: false,
      });
      expect(again.id).toBe(price.id);
      expect(again.active).toBe(false);

      // `active` moves both ways, and the money-bearing fields survive the
      // round trip, which is the immutability claim that actually matters.
      const back = await client.prices.update<{ active: boolean; amount_cents: number }>(price.id, {
        active: true,
      });
      expect(back.active).toBe(true);
      expect(back.amount_cents).toBe(777);
    });

    scenario("crud.customer", "customer round-trips and delete removes it from the list", async () => {
      const email = `cust-${idemKey()}@sdk-it.example.com`;
      const created = await client.customers.create<{ id: string; email: string }>({
        email,
        name: "Ada Lovelace",
      });
      expect(created.email).toBe(email);

      const updated = await client.customers.update<{ name: string }>(created.id, {
        name: "Ada L.",
      });
      expect(updated.name).toBe("Ada L.");

      const deleted = await client.customers.delete<{
        id: string;
        object: string;
        deleted: boolean;
      }>(created.id);
      // The customer leaves the API, so the body is a marker, not a row.
      expect(deleted).toEqual({ id: created.id, object: "customer", deleted: true });

      const page = await client.customers.list<{ data: Array<{ id: string }> }>({ limit: 100 });
      expect(page.data.map((c) => c.id)).not.toContain(created.id);
    });

    scenario("crud.coupon", "coupon creates, validates, updates, withdraws", async () => {
      const code = `SAVE${Date.now().toString().slice(-8)}`;
      const created = await client.coupons.create<{ id: string; code: string }>({
        code,
        discount_type: "percent",
        discount_value: 25,
        duration: "once",
      });
      expect(created.code).toBe(code);

      const validated = await client.coupons.validate<{ valid: boolean }>({ code });
      expect(validated.valid).toBe(true);

      await client.coupons.update(created.id, { max_redemptions: 5 });
      await client.coupons.update(created.id, { active: false });

      // A withdrawn coupon must stop validating, otherwise a retired
      // discount would keep applying at checkout.
      const afterWithdraw = await client.coupons.validate<{ valid: boolean }>({ code });
      expect(afterWithdraw.valid).toBe(false);

      // ...while staying readable, because a discount already applied to
      // a live subscription has to be traceable to the coupon behind it.
      const stillThere = await client.coupons.retrieve<{ active: boolean }>(created.id);
      expect(stillThere.active).toBe(false);
    });

    scenario("crud.tax_rate", "tax rate round-trips", async () => {
      const created = await client.taxRates.create<{ id: string; rate_basis_points: number }>({
        country_code: "NL",
        rate_basis_points: 2100,
        display_name: "NL VAT",
      });
      expect(created.rate_basis_points).toBe(2100);

      const updated = await client.taxRates.update<{ rate_basis_points: number }>(created.id, {
        rate_basis_points: 900,
      });
      expect(updated.rate_basis_points).toBe(900);

      // Retiring is an update, and the rate stays readable: an invoice
      // records the percentage it charged, not the rate row.
      const retired = await client.taxRates.update<{ active: boolean }>(created.id, {
        active: false,
      });
      expect(retired.active).toBe(false);
      const stillReadable = await client.taxRates.retrieve<{ active: boolean }>(created.id);
      expect(stillReadable.active).toBe(false);
    });

    scenario("crud.webhook_endpoint", "endpoint round-trips and rotates its secret", async () => {
      const created = await client.webhookEndpoints.create<{ id: string; secret: string }>({
        url: "https://merchant.example.com/hooks/billkit",
        enabled_events: ["*"],
        description: "node integration suite",
      });
      // The signing secret is returned exactly once, on create.
      expect(created.secret).toMatch(/^bkwhsec_/);

      await client.webhookEndpoints.update(created.id, { description: "renamed" });

      const rotated = await client.webhookEndpoints.rotateSecret<{ secret: string }>(created.id);
      expect(rotated.secret).toMatch(/^bkwhsec_/);
      expect(rotated.secret).not.toBe(created.secret);

      // Disabling stops delivery and keeps everything else, so the
      // endpoint is still listed and can be turned back on.
      const disabled = await client.webhookEndpoints.update<{ status: string }>(created.id, {
        status: "disabled",
      });
      expect(disabled.status).toBe("disabled");
      const page = await client.webhookEndpoints.list<{ data: Array<{ id: string }> }>({
        limit: 100,
      });
      expect(page.data.map((e) => e.id)).toContain(created.id);

      // Deleting is the other act, and it is a real one: a URL registered
      // by mistake leaves the account rather than sitting there disabled
      // for good.
      const gone = await client.webhookEndpoints.delete<{ id: string; deleted: boolean }>(
        created.id,
      );
      expect(gone).toEqual({ id: created.id, object: "webhook_endpoint", deleted: true });
      await expect(client.webhookEndpoints.retrieve(created.id)).rejects.toThrow();
      const after = await client.webhookEndpoints.list<{ data: Array<{ id: string }> }>({
        limit: 100,
      });
      expect(after.data.map((e) => e.id)).not.toContain(created.id);
    });

    scenario(
      "crud.price_decimal_rate",
      "a 12-dp unit_amount_decimal round-trips byte-identical as a string",
      async () => {
        const product = await client.products.create<{ id: string }>({
          name: `Metered ${idemKey()}`,
        });
        // Twelve decimal places, in MINOR units. The value is chosen so that
        // any float anywhere on the path visibly destroys it.
        const RATE = "0.000000000001";
        const price = await client.prices.create<{
          id: string;
          unit_amount_decimal: string;
          usage_type: string;
        }>({
          product_id: product.id,
          currency: "EUR",
          interval: "month",
          usage_type: "metered",
          unit_amount_decimal: RATE,
        });
        expect(typeof price.unit_amount_decimal).toBe("string");
        expect(price.unit_amount_decimal).toBe(RATE);

        // And on the read path, which is a separate serializer.
        const fetched = await client.prices.retrieve<{ unit_amount_decimal: string }>(price.id);
        expect(typeof fetched.unit_amount_decimal).toBe("string");
        expect(fetched.unit_amount_decimal).toBe(RATE);
      },
    );

    scenario("crud.price_tiered", "a tiered metered price round-trips every band", async () => {
      const product = await client.products.create<{ id: string }>({
        name: `Tiered ${idemKey()}`,
      });
      const price = await client.prices.create<{
        id: string;
        billing_scheme: string;
        tiers_mode: string;
        tiers: Array<{ up_to: number | string; unit_amount_decimal?: string }>;
      }>({
        product_id: product.id,
        currency: "EUR",
        interval: "month",
        usage_type: "metered",
        billing_scheme: "tiered",
        // Never defaulted: the same table under the two modes is a different
        // bill, not a rounding difference.
        tiers_mode: "graduated",
        tiers: [
          { up_to: 1000, unit_amount_decimal: "0.05" },
          { up_to: "inf", unit_amount_decimal: "0.0125" },
        ],
      });
      expect(price.billing_scheme).toBe("tiered");
      expect(price.tiers_mode).toBe("graduated");
      expect(price.tiers).toHaveLength(2);
      for (const tier of price.tiers) {
        expect(typeof tier.unit_amount_decimal).toBe("string");
      }
      expect(price.tiers[0]!.unit_amount_decimal).toBe("0.05");
      expect(price.tiers[1]!.unit_amount_decimal).toBe("0.0125");
    });

    scenario(
      "crud.credit_note_absent_until_refunded",
      "credit notes are issued, never created",
      async () => {
        // There is no `create` on the resource at all — issuance hangs off a
        // settled refund. Assert the read surface is reachable and honest
        // about having nothing yet.
        const page = await client.creditNotes.list<{ object: string; data: unknown[] }>({
          limit: 10,
        });
        expect(page.object).toBe("list");
        await expect(client.creditNotes.retrieve("cn_does_not_exist")).rejects.toBeInstanceOf(
          ResourceMissingError,
        );
      },
    );
  });

  // ── filters ───────────────────────────────────────────────────────

  describe("filters", () => {
    scenario(
      "filters.subscription_renewal_state",
      "a paused subscription is found by renewal_state, never by status",
      async () => {
        const t = await provisionTenant("renewal");
        const c = new BillKit({ apiKey: t.apiKey, baseUrl: BASE_URL });
        const { price } = await makePlan(c, { amountCents: 1500 });
        const sub = await activeSubscription(c, t, price.id);

        const paused = await c.subscriptions.pause<{ status: string; renewal_state: string }>(
          sub.id,
        );
        // The whole point: pausing lands in renewal_state and leaves
        // status alone, because the customer has paid for this period.
        expect(paused.renewal_state).toBe("paused");
        expect(paused.status).toBe("active");

        const byRenewalState = await c.subscriptions.list<{ data: Array<{ id: string }> }>({
          renewal_state: "paused",
        });
        expect(byRenewalState.data.map((s) => s.id)).toContain(sub.id);

        // ...and it is still an `active` subscription to the status filter.
        const byStatus = await c.subscriptions.list<{ data: Array<{ id: string }> }>({
          status: "active",
        });
        expect(byStatus.data.map((s) => s.id)).toContain(sub.id);

        // `status=paused` is not a value the API accepts. It used to be,
        // and returned a confident, wrong, empty page; now it is refused
        // so the mistake is visible.
        const err = await c.subscriptions.list({ status: "paused" }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InvalidRequestError);
        expect((err as InvalidRequestError).param).toBe("status");
      },
    );
  });

  // ── pagination ────────────────────────────────────────────────────

  describe("pagination", () => {
    scenario("pagination.has_more", "a short limit reports has_more", async () => {
      const c = new BillKit({ apiKey: (await provisionTenant("page")).apiKey, baseUrl: BASE_URL });
      for (let i = 0; i < 5; i++) {
        await c.products.create({ name: `Paged ${i}` });
      }
      const page = await c.products.list<{ data: unknown[]; has_more: boolean }>({ limit: 2 });
      expect(page.data).toHaveLength(2);
      expect(page.has_more).toBe(true);
    });

    scenario("pagination.auto_iter", "the iterator yields every row exactly once", async () => {
      // A dedicated tenant so the expected set is exactly what we created.
      const t = await provisionTenant("iter");
      const c = new BillKit({ apiKey: t.apiKey, baseUrl: BASE_URL });
      const expected = new Set<string>();
      for (let i = 0; i < 7; i++) {
        const p = await c.products.create<{ id: string }>({ name: `Iter ${i}` });
        expected.add(p.id);
      }

      const seen: string[] = [];
      for await (const product of c.products.iter<{ id: string }>({ pageSize: 2 })) {
        seen.push(product.id);
      }
      // Exactly-once is the real assertion: a cursor that mis-orders ties
      // shows up here as a duplicate or a dropped row, not as a crash.
      expect(seen).toHaveLength(expected.size);
      expect(new Set(seen)).toEqual(expected);
    });
  });

  // ── idempotency ───────────────────────────────────────────────────

  describe("idempotency", () => {
    scenario("idempotency.replay", "the same key + body replays the same resource", async () => {
      const key = idemKey();
      const body = { name: "Idempotent Product" };
      const first = await client.products.create<{ id: string }>({ ...body, idempotencyKey: key });
      const second = await client.products.create<{ id: string }>({ ...body, idempotencyKey: key });
      expect(second.id).toBe(first.id);
    });

    scenario(
      "idempotency.key_reuse_conflict",
      "the same key with a different body conflicts",
      async () => {
        const key = idemKey();
        await client.products.create({ name: "First Body", idempotencyKey: key });
        await expect(
          client.products.create({ name: "Different Body", idempotencyKey: key }),
        ).rejects.toBeInstanceOf(ConflictError);
      },
    );
  });

  // ── errors ────────────────────────────────────────────────────────

  describe("errors", () => {
    scenario("errors.not_found", "404 maps to ResourceMissingError", async () => {
      await expect(client.products.retrieve("prod_does_not_exist")).rejects.toBeInstanceOf(
        ResourceMissingError,
      );
    });

    scenario(
      "errors.invalid_request",
      "a validation failure maps to InvalidRequestError and carries `param`",
      async () => {
        // A 4-char currency fails schema validation (422,
        // type=invalid_request_error). Asserting on `param` is the point:
        // it proves the envelope's field-level detail survives the wire
        // round-trip into the typed exception, which is what lets a caller
        // highlight the offending input rather than show a generic error.
        const err = await client.prices
          .create({
            product_id: "prod_whatever",
            amount_cents: 100,
            currency: "EURO",
            interval: "month",
          })
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(InvalidRequestError);
        expect((err as InvalidRequestError).param).toBe("currency");
        expect((err as InvalidRequestError).code).toBe("parameter_invalid");
      },
    );
  });

  // ── money ─────────────────────────────────────────────────────────

  describe("money", () => {
    scenario("money.checkout_to_active", "checkout settles into an active subscription", async () => {
      const { price } = await makePlan(client, { amountCents: 4200 });
      await checkoutToActive(client, tenant, price.id);

      const subs = await client.subscriptions.list<{
        data: Array<{ id: string; status: string; price_id: string }>;
      }>({ limit: 100 });
      const sub = subs.data.find((s) => s.price_id === price.id);
      expect(sub, "a subscription should exist for the settled checkout").toBeTruthy();
      expect(sub!.status).toBe("active");

      const payments = await client.payments.list<{
        data: Array<{ subscription_id: string | null; status: string; amount_cents: number }>;
      }>({ limit: 100 });
      const paid = payments.data.find((p) => p.subscription_id === sub!.id);
      expect(paid, "the settled payment should be listed").toBeTruthy();
      expect(paid!.status).toBe("paid");
      expect(paid!.amount_cents).toBe(4200);
    });

    scenario("money.partial_refund", "a partial refund leaves the remainder refundable", async () => {
      const { price } = await makePlan(client, { amountCents: 10_000 });
      await checkoutToActive(client, tenant, price.id);

      const subs = await client.subscriptions.list<{
        data: Array<{ id: string; price_id: string }>;
      }>({ limit: 100 });
      const sub = subs.data.find((s) => s.price_id === price.id)!;

      const payments = await client.payments.list<{
        data: Array<{ id: string; subscription_id: string | null }>;
      }>({ limit: 100 });
      const payment = payments.data.find((p) => p.subscription_id === sub.id)!;

      const refund = await client.refunds.create<{ id: string; amount_cents: number }>({
        payment_id: payment.id,
        amount_cents: 3000,
        reason: "integration partial",
      });
      expect(refund.amount_cents).toBe(3000);

      const after = await client.payments.retrieve<{
        amount_refunded_cents: number;
        amount_refundable_cents: number;
      }>(payment.id);
      expect(after.amount_refunded_cents).toBe(3000);
      expect(after.amount_refundable_cents).toBe(7000);
    });

    scenario("money.over_refund_rejected", "refunding beyond the balance is rejected", async () => {
      const { price } = await makePlan(client, { amountCents: 5000 });
      await checkoutToActive(client, tenant, price.id);

      const subs = await client.subscriptions.list<{
        data: Array<{ id: string; price_id: string }>;
      }>({ limit: 100 });
      const sub = subs.data.find((s) => s.price_id === price.id)!;
      const payments = await client.payments.list<{
        data: Array<{ id: string; subscription_id: string | null }>;
      }>({ limit: 100 });
      const payment = payments.data.find((p) => p.subscription_id === sub.id)!;

      // The guard that stops BillKit paying out more than it took.
      await expect(
        client.refunds.create({ payment_id: payment.id, amount_cents: 5001 }),
      ).rejects.toBeInstanceOf(InvalidRequestError);
    });

    scenario("money.dispute_opened", "a chargeback opens a listable dispute", async () => {
      const { price } = await makePlan(client, { amountCents: 7700 });
      const { providerPaymentId } = await checkoutToActive(client, tenant, price.id);

      // Open the chargeback at the provider, then re-deliver the payment
      // webhook. The reconciler picks the transition up on that hop.
      await mollie.chargeback(providerPaymentId, "77.00", "fraudulent");
      await deliverMollieWebhook(tenant.mollieRouteId, providerPaymentId);

      const disputes = await client.disputes.list<{
        data: Array<{ id: string; status: string; amount_cents: number }>;
      }>({ limit: 100 });
      expect(disputes.data.length).toBeGreaterThan(0);

      const dispute = disputes.data.find((x) => x.amount_cents === 7700);
      expect(dispute, "a dispute should exist for the charged-back payment").toBeTruthy();
      expect(dispute!.status).toBe("open");

      const fetched = await client.disputes.retrieve<{ id: string }>(dispute!.id);
      expect(fetched.id).toBe(dispute!.id);
    });

    scenario(
      "money.credit_note_for_refund",
      "a settled refund issues a retrievable credit note",
      async () => {
        const { price } = await makePlan(client, { amountCents: 6400 });
        const { providerPaymentId } = await checkoutToActive(client, tenant, price.id);

        const subs = await client.subscriptions.list<{
          data: Array<{ id: string; price_id: string }>;
        }>({ limit: 100 });
        const sub = subs.data.find((s) => s.price_id === price.id)!;
        const payments = await client.payments.list<{
          data: Array<{ id: string; subscription_id: string | null }>;
        }>({ limit: 100 });
        const payment = payments.data.find((p) => p.subscription_id === sub.id)!;

        const invoices = await client.invoices.list<{
          data: Array<{ id: string; payment_id: string | null; number: string }>;
        }>({ limit: 100 });
        const invoice = invoices.data.find((i) => i.payment_id === payment.id)!;
        expect(invoice, "the settled charge should have produced an invoice").toBeTruthy();

        const refund = await client.refunds.create<{ id: string; status: string }>({
          payment_id: payment.id,
          amount_cents: 6400,
        });
        expect(refund.status).toBe("pending");

        // Nothing yet: the refund is pending and may still fail, and a
        // gapless series cannot un-issue a number.
        const before = await client.creditNotes.list<{ data: Array<{ id: string }> }>({
          invoice_id: invoice.id,
        });
        expect(before.data).toHaveLength(0);

        // Settle it at the provider, then re-deliver the payment webhook —
        // the same order every money spec here uses.
        await mollie.settleRefundsFor(providerPaymentId, "refunded");
        await deliverMollieWebhook(tenant.mollieRouteId, providerPaymentId);

        const notes = await client.creditNotes.list<{
          data: Array<{
            id: string;
            number: string;
            invoice_id: string;
            subtotal_cents: number;
            tax_cents: number;
            total_cents: number;
          }>;
        }>({ invoice_id: invoice.id });
        expect(notes.data).toHaveLength(1);
        const note = notes.data[0]!;
        expect(note.invoice_id).toBe(invoice.id);
        // Its own series, deliberately distinct from the invoice's: a tax
        // authority reads the two as different document classes.
        expect(note.number.startsWith("CN-")).toBe(true);
        expect(note.number).not.toBe(invoice.number);
        // The identity the whole document rests on.
        expect(note.subtotal_cents + note.tax_cents).toBe(note.total_cents);
        expect(note.total_cents).toBe(6400);

        const fetched = await client.creditNotes.retrieve<{ id: string; object: string }>(note.id);
        expect(fetched.id).toBe(note.id);
        expect(fetched.object).toBe("credit_note");
      },
    );

    scenario(
      "money.void_refused_on_paid_invoice",
      "voiding a paid invoice is a typed conflict",
      async () => {
        const { price } = await makePlan(client, { amountCents: 1900 });
        await checkoutToActive(client, tenant, price.id);

        const subs = await client.subscriptions.list<{
          data: Array<{ id: string; price_id: string }>;
        }>({ limit: 100 });
        const sub = subs.data.find((s) => s.price_id === price.id)!;
        const invoices = await client.invoices.list<{
          data: Array<{ id: string; subscription_id: string | null; status: string }>;
        }>({ limit: 100 });
        const invoice = invoices.data.find((i) => i.subscription_id === sub.id)!;
        expect(invoice.status).toBe("paid");

        // Not a limitation — the contract. Voiding claims the sale was never
        // owed, which is false once the money moved; the reversal there is a
        // credit note.
        await expect(client.invoices.void(invoice.id)).rejects.toBeInstanceOf(ConflictError);
        await client.invoices.void(invoice.id).catch((err: unknown) => {
          expect((err as { code?: string }).code).toBe("invoice_not_voidable");
        });
      },
    );
  });

  // ── usage ─────────────────────────────────────────────────────────

  describe("usage", () => {
    scenario(
      "usage.record_and_replay",
      "a usage record posts to a metered subscription and replays by key",
      async () => {
        const { price } = await makePlan(client, { amountCents: 5, usageType: "metered" });
        const sub = await activeSubscription(client, tenant, price.id);

        const key = idemKey();
        const record = await client.subscriptions.createUsageRecord<{
          id: string;
          object: string;
          subscription_id: string;
          quantity: number;
          invoice_id: string | null;
        }>(sub.id, { quantity: 42, metadata: { source: "node-it" }, idempotencyKey: key });
        expect(record.object).toBe("usage_record");
        expect(record.subscription_id).toBe(sub.id);
        expect(record.quantity).toBe(42);
        expect(record.invoice_id).toBeNull();

        // Replaying the same key must return the same record, not
        // double-count the usage: that is what makes at-least-once
        // reporting pipelines safe to retry.
        const replay = await client.subscriptions.createUsageRecord<{ id: string }>(sub.id, {
          quantity: 42,
          metadata: { source: "node-it" },
          idempotencyKey: key,
        });
        expect(replay.id).toBe(record.id);
      },
    );

    scenario(
      "usage.list_reconciliation",
      "invoice_id=pending returns the posted, not-yet-invoiced records",
      async () => {
        const { price } = await makePlan(client, { amountCents: 3, usageType: "metered" });
        const sub = await activeSubscription(client, tenant, price.id);

        const posted: string[] = [];
        for (const quantity of [10, 20, 30]) {
          const r = await client.subscriptions.createUsageRecord<{ id: string }>(sub.id, {
            quantity,
          });
          posted.push(r.id);
        }

        const pending = await client.subscriptions.listUsageRecords<{
          id: string;
          quantity: number;
          invoice_id: string | null;
        }>(sub.id, { invoice_id: "pending", limit: 100 });
        expect(pending.object).toBe("list");
        const ids = pending.data.map((r) => r.id);
        for (const id of posted) expect(ids).toContain(id);
        // Nothing pending may already claim an invoice.
        for (const r of pending.data) expect(r.invoice_id).toBeNull();
      },
    );

    scenario(
      "usage.non_metered_rejected",
      "posting usage to a licensed subscription is a typed 400",
      async () => {
        const { price } = await makePlan(client, { amountCents: 2500 });
        const sub = await activeSubscription(client, tenant, price.id);

        await expect(
          client.subscriptions.createUsageRecord(sub.id, { quantity: 1 }),
        ).rejects.toBeInstanceOf(InvalidRequestError);
      },
    );

    scenario(
      "usage.dedupe_identifier",
      "the same identifier under a different key returns the record on file",
      async () => {
        const { price } = await makePlan(client, { amountCents: 7, usageType: "metered" });
        const sub = await activeSubscription(client, tenant, price.id);

        const identifier = `job-${idemKey()}`;
        const first = await client.subscriptions.createUsageRecord<{ id: string }>(sub.id, {
          quantity: 9,
          identifier,
          idempotencyKey: idemKey(),
        });
        // A DIFFERENT idempotency key, so the transport-level replay guard
        // cannot be what dedupes this. Only the natural key can.
        const second = await client.subscriptions.createUsageRecord<{ id: string }>(sub.id, {
          quantity: 9,
          identifier,
          idempotencyKey: idemKey(),
        });
        expect(second.id).toBe(first.id);

        const pending = await client.subscriptions.listUsageRecords<{ id: string }>(sub.id, {
          invoice_id: "pending",
          limit: 100,
        });
        expect(pending.data.filter((r) => r.id === first.id)).toHaveLength(1);
      },
    );

    scenario(
      "usage.summary_forecast",
      "usage_summary says what the next close will bill",
      async () => {
        const { price } = await makePlan(client, { amountCents: 11, usageType: "metered" });
        const sub = await activeSubscription(client, tenant, price.id);
        for (const quantity of [100, 250]) {
          await client.subscriptions.createUsageRecord(sub.id, { quantity });
        }

        const summary = await client.subscriptions.retrieveUsageSummary<{
          object: string;
          subscription_id: string;
          pending_quantity: number;
          pending_record_count: number;
          net_cents: number;
          tax_cents: number;
          gross_cents: number;
          currency: string;
          will_charge: boolean;
          minimum_charge_cents: number;
        }>(sub.id);
        expect(summary.subscription_id).toBe(sub.id);
        expect(summary.pending_quantity).toBe(350);
        expect(summary.pending_record_count).toBe(2);
        // 350 units at 11 cents. The forecast and the close share one
        // predicate server-side, so this is the invoice, not an estimate.
        expect(summary.net_cents).toBe(3850);
        expect(summary.net_cents + summary.tax_cents).toBe(summary.gross_cents);
        expect(summary.will_charge).toBe(true);
      },
    );
  });

  // ── webhooks ──────────────────────────────────────────────────────

  describe("webhooks", () => {
    // Sign with the SDK's own algorithm so the round-trip proves the
    // documented wire format ("{t}." + rawBody, HMAC-SHA256, hex).
    async function sign(secret: string, body: string, ts: number): Promise<string> {
      const { createHmac } = await import("node:crypto");
      const mac = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
      return `t=${ts},v1=${mac}`;
    }

    const SECRET = "bkwhsec_integration_secret";
    const BODY = JSON.stringify({ id: "evt_1", type: "subscription.created" });

    scenario("webhooks.verify_roundtrip", "a correctly signed payload verifies", async () => {
      const ts = Math.floor(Date.now() / 1000);
      const event = await verifyWebhookSignature<{ id: string }>({
        payload: BODY,
        signatureHeader: await sign(SECRET, BODY, ts),
        secret: SECRET,
      });
      expect(event.id).toBe("evt_1");
    });

    scenario("webhooks.reject_tampered", "a mutated body fails verification", async () => {
      const ts = Math.floor(Date.now() / 1000);
      const header = await sign(SECRET, BODY, ts);
      await expect(
        verifyWebhookSignature({
          payload: BODY.replace("evt_1", "evt_2"),
          signatureHeader: header,
          secret: SECRET,
        }),
      ).rejects.toBeInstanceOf(WebhookVerificationError);
    });

    scenario("webhooks.reject_stale", "a timestamp outside tolerance fails verification", async () => {
      const stale = Math.floor(Date.now() / 1000) - 10_000;
      await expect(
        verifyWebhookSignature({
          payload: BODY,
          signatureHeader: await sign(SECRET, BODY, stale),
          secret: SECRET,
        }),
      ).rejects.toBeInstanceOf(WebhookVerificationError);
    });
  });

  // ── parity gate ───────────────────────────────────────────────────

  afterAll(() => {
    assertManifestCoverage();
  });
});
