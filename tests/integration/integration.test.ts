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
  opts: { amountCents?: number; interval?: "month" | "year"; trialDays?: number } = {},
) {
  const product = await c.products.create<{ id: string }>({ name: `Plan ${idemKey()}` });
  const price = await c.prices.create<{ id: string; amount_cents: number }>({
    product_id: product.id,
    amount_cents: opts.amountCents ?? 2500,
    currency: "EUR",
    interval: opts.interval ?? "month",
    trial_days: opts.trialDays ?? 0,
  });
  return { product, price };
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
        apiKey: "sk_test_0000000000000000000000",
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

      const deleted = await client.products.delete<{ active: boolean }>(created.id);
      expect(deleted.active).toBe(false);
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

      await client.customers.delete(created.id);
      const page = await client.customers.list<{ data: Array<{ id: string }> }>({ limit: 100 });
      expect(page.data.map((c) => c.id)).not.toContain(created.id);
    });

    scenario("crud.coupon", "coupon creates, validates, updates, deletes", async () => {
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
      await client.coupons.delete(created.id);

      // A deleted coupon must stop validating, otherwise a revoked
      // discount would keep applying at checkout.
      const afterDelete = await client.coupons.validate<{ valid: boolean }>({ code });
      expect(afterDelete.valid).toBe(false);
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

      await client.taxRates.delete(created.id);
    });

    scenario("crud.webhook_endpoint", "endpoint round-trips and rotates its secret", async () => {
      const created = await client.webhookEndpoints.create<{ id: string; secret: string }>({
        url: "https://merchant.example.com/hooks/billkit",
        enabled_events: ["*"],
        description: "node integration suite",
      });
      // The signing secret is returned exactly once, on create.
      expect(created.secret).toMatch(/^whsec_/);

      await client.webhookEndpoints.update(created.id, { description: "renamed" });

      const rotated = await client.webhookEndpoints.rotateSecret<{ secret: string }>(created.id);
      expect(rotated.secret).toMatch(/^whsec_/);
      expect(rotated.secret).not.toBe(created.secret);

      await client.webhookEndpoints.delete(created.id);
    });
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

    const SECRET = "whsec_integration_secret";
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
