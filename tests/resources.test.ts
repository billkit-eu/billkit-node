/**
 * Coverage for the resource families added when the SDK reached
 * Python parity: Tenant, Coupons, TaxRates, Invoices, AuditLogs,
 * Payments, BillingPortalSessions, and the new WebhookEndpoints
 * deliveries verbs.
 *
 * The transport already has its own tests; here we just assert the
 * resource methods build the right URL + method + body. One test per
 * verb is enough; the per-verb assertions catch the most likely
 * regressions (wrong path, missing field, leaked `undefined`).
 */

import { describe, expect, it } from "vitest";

import { BillKit } from "../src/client.js";
import { ServerError } from "../src/errors.js";
import { FAST_RETRY, makeMockFetch } from "./helpers.js";

function client(fetchImpl: typeof fetch) {
  return new BillKit({
    apiKey: "bk_test_unit",
    baseUrl: "https://test.billkit.eu",
    retryPolicy: FAST_RETRY,
    fetch: fetchImpl,
  });
}

describe("Tenant", () => {
  it("GETs /v1/tenant/capabilities", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { profile_id: "pfl_x", payment_methods: ["creditcard"] } },
    ]);
    await client(fetchImpl).tenant.capabilities();
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/tenant/capabilities");
    expect(calls[0]?.method).toBe("GET");
  });

  it("setPortalBranding only sends defined fields", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: {} }]);
    await client(fetchImpl).tenant.setPortalBranding({
      business_name: "Acme",
      support_email: "ops@acme.test",
    });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.business_name).toBe("Acme");
    expect(body.support_email).toBe("ops@acme.test");
    expect("logo_url" in body).toBe(false);
    expect("theme" in body).toBe(false);
  });

  it("rotateProviderCredential carries idempotency key", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: {} }]);
    await client(fetchImpl).tenant.rotateProviderCredential({
      api_key: "live_rotated",
      idempotencyKey: "rotate-1",
    });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.api_key).toBe("live_rotated");
    expect("idempotencyKey" in body).toBe(false);
    expect(calls[0]?.headers["idempotency-key"]).toBe("rotate-1");
  });
});

describe("Coupons", () => {
  it("create posts to /v1/coupons with discount fields", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: { id: "cpn_1" } }]);
    await client(fetchImpl).coupons.create({
      code: "WELCOME10",
      discount_type: "percentage",
      discount_value: 10,
      duration: "once",
    });
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/coupons");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.code).toBe("WELCOME10");
    expect(body.duration).toBe("once");
  });

  it("validate posts to /v1/coupons/validate with no idempotency", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { eligible: true, discount_amount_cents: 100 } },
    ]);
    await client(fetchImpl).coupons.validate({
      code: "WELCOME10",
      price_id: "price_1",
      amount_cents: 1000,
    });
    // validate is read-only-shaped; we still let the auto-idempotency
    // wrap it because the API treats POSTs as mutating. The point of
    // this test is to confirm the body shape.
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/coupons/validate");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body).toEqual({ code: "WELCOME10", price_id: "price_1", amount_cents: 1000 });
  });
});

describe("TaxRates", () => {
  it("create + update map to /v1/tax_rates", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "tax_1" } },
      { status: 200, body: { id: "tax_1", active: false } },
    ]);
    await client(fetchImpl).taxRates.create({
      country_code: "NL",
      rate_basis_points: 2100,
      display_name: "BTW 21%",
    });
    await client(fetchImpl).taxRates.update("tax_1", { active: false });
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/tax_rates");
    expect(calls[1]?.url).toBe("https://test.billkit.eu/v1/tax_rates/tax_1");
    expect(JSON.parse(calls[1]?.body ?? "{}").active).toBe(false);
  });
});

describe("Invoices, Payments, AuditLogs (read-only)", () => {
  it("Invoices.retrieve uses /v1/invoices/{id}", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: { id: "in_1" } }]);
    await client(fetchImpl).invoices.retrieve("in_1");
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/invoices/in_1");
  });

  it("Invoices.retrievePdf GETs /pdf and hands back the raw bytes", async () => {
    // Not `makeMockFetch`: that helper JSON-stringifies every staged
    // body, and the point of this path is that the bytes are *not* JSON.
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(input.toString());
      return new Response(pdf, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    };

    const bytes = await client(fetchImpl).invoices.retrievePdf("in_1");

    expect(calls[0]).toBe("https://test.billkit.eu/v1/invoices/in_1/pdf");
    expect(bytes).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(bytes)).toBe("%PDF-1.7");
  });

  it("Invoices.retrievePdf still raises the typed error envelope", async () => {
    // `INVOICE_PDF_ENABLED=false` answers 501 with the normal envelope;
    // the binary path must decode that rather than hand back bytes.
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: { type: "api_error", code: "rendering_pending", message: "off" },
        }),
        { status: 501, headers: { "content-type": "application/json" } },
      );

    try {
      await client(fetchImpl).invoices.retrievePdf("in_1");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError);
      expect((err as ServerError).code).toBe("rendering_pending");
      expect((err as ServerError).statusCode).toBe(501);
    }
  });

  it("Payments.list maps to /v1/payments", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { object: "list", data: [], has_more: false } },
    ]);
    await client(fetchImpl).payments.list({ limit: 5 });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/payments");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("AuditLogs.list forwards action + actor_id filters", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { object: "list", data: [], has_more: false } },
    ]);
    await client(fetchImpl).auditLogs.list({
      action: "customer.created",
      actor_id: "act_1",
      limit: 10,
    });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("action")).toBe("customer.created");
    expect(url.searchParams.get("actor_id")).toBe("act_1");
    expect(url.searchParams.get("limit")).toBe("10");
  });
});

describe("BillingPortalSessions", () => {
  it("create posts both required fields and auto-idempotency", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "bps_1", token: "bk_portal_...", url: "https://..." } },
    ]);
    await client(fetchImpl).billingPortalSessions.create({
      subscription_id: "sub_1",
      return_url: "https://app.example.com/billing",
    });
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/billing_portal/sessions");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body).toEqual({
      subscription_id: "sub_1",
      return_url: "https://app.example.com/billing",
    });
    expect(calls[0]?.headers["idempotency-key"]).toMatch(/^sdk-/);
  });

  it("revoke posts to the revoke route", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: { id: "bps_1" } }]);
    await client(fetchImpl).billingPortalSessions.revoke("bps_1");
    expect(calls[0]?.url).toBe(
      "https://test.billkit.eu/v1/billing_portal/sessions/bps_1/revoke",
    );
    expect(calls[0]?.method).toBe("POST");
  });
});

describe("Customers: VAT + GDPR purge", () => {
  it("create does not send vat_number (separate endpoint)", async () => {
    // Regression for the 0.1 → 0.2 contract fix: the API's
    // `CustomerCreate` schema is `extra="forbid"`. Sending `vat_number`
    // here would 422; VAT lives at `POST /v1/customers/{id}/vat_number`.
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: { id: "cus_1" } }]);
    await client(fetchImpl).customers.create({
      email: "ada@example.com",
      name: "Ada",
      country_code: "NL",
    });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect("vat_number" in body).toBe(false);
    expect(body.email).toBe("ada@example.com");
  });

  it("setVatNumber posts to /v1/customers/{id}/vat_number", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "cus_1", vat_number: "NL123456789B01", vat_number_validated: true } },
    ]);
    await client(fetchImpl).customers.setVatNumber("cus_1", {
      vat_number: "NL123456789B01",
      country_code: "NL",
    });
    expect(calls[0]?.url).toBe(
      "https://test.billkit.eu/v1/customers/cus_1/vat_number",
    );
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.vat_number).toBe("NL123456789B01");
    expect(body.country_code).toBe("NL");
  });

  it("purge defaults confirmed=true so the SDK caller doesn't no-op", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: { id: "cus_1", purged_at: 0 } }]);
    await client(fetchImpl).customers.purge("cus_1");
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/customers/cus_1/purge");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body).toEqual({ confirmed: true });
  });
});

describe("CheckoutSessions: 0.2 body shape", () => {
  it("uses method / coupon_code / trial_days_override, not the old 0.1 names", async () => {
    // 0.1 sent payment_method / coupon / metadata which the API rejects.
    // 0.2 mirrors the server schema names.
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "cs_1", url: "https://www.mollie.com/checkout/cs_1" } },
    ]);
    await client(fetchImpl).checkoutSessions.create({
      customer_id: "cus_1",
      price_id: "price_1",
      success_url: "https://app.example.com/ok",
      cancel_url: "https://app.example.com/no",
      method: "creditcard",
      coupon_code: "LAUNCH50",
      trial_days_override: 7,
    });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.method).toBe("creditcard");
    expect(body.coupon_code).toBe("LAUNCH50");
    expect(body.trial_days_override).toBe(7);
    // The 0.1 names must not slip back in.
    expect("payment_method" in body).toBe(false);
    expect("coupon" in body).toBe(false);
    expect("metadata" in body).toBe(false);
  });

  it("customer_email shortcut omits customer_id and carries the new fields", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "cs_1", customer_id: "cus_fresh" } },
    ]);
    await client(fetchImpl).checkoutSessions.create({
      customer_email: "ada@example.com",
      customer_name: "Ada Lovelace",
      price_id: "price_1",
      success_url: "https://app.example.com/ok",
      cancel_url: "https://app.example.com/no",
    });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.customer_email).toBe("ada@example.com");
    expect(body.customer_name).toBe("Ada Lovelace");
    expect("customer_id" in body).toBe(false);
  });

  it("forwards ui_mode + metadata so the embedded element is reachable", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "cs_1", client_secret: "cs_1_secret_abc" } },
    ]);
    await client(fetchImpl).checkoutSessions.create({
      customer_email: "ada@example.com",
      price_id: "price_1",
      success_url: "https://app.example.com/ok",
      cancel_url: "https://app.example.com/no",
      ui_mode: "embedded",
      metadata: { order_id: "ord_42" },
    });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.ui_mode).toBe("embedded");
    expect(body.metadata).toEqual({ order_id: "ord_42" });
  });
});

describe("OneShotPayments", () => {
  it("create posts to /v1/checkout/one_shot with the charge fields", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 200,
        body: { id: "osp_1", object: "one_shot_payment", status: "open", redirect_url: "https://..." },
      },
    ]);
    await client(fetchImpl).oneShotPayments.create({
      customer_id: "cus_1",
      amount_cents: 2500,
      currency: "EUR",
      method: "ideal",
      success_url: "https://shop.example.com/thanks",
      refund_window_days: 0,
    });
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/checkout/one_shot");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.customer_id).toBe("cus_1");
    expect(body.amount_cents).toBe(2500);
    expect(body.method).toBe("ideal");
    // `0` must survive dropUndefined; it disables refunds for this payment.
    expect(body.refund_window_days).toBe(0);
    // Auto-idempotency wraps the mutating call.
    expect(calls[0]?.headers["idempotency-key"]).toMatch(/^sdk-/);
  });

  it("retrieve fetches /v1/checkout/one_shot/{id}", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: { id: "osp_1" } }]);
    await client(fetchImpl).oneShotPayments.retrieve("osp_1");
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/checkout/one_shot/osp_1");
    expect(calls[0]?.method).toBe("GET");
  });
});

describe("Refunds: one-shot target", () => {
  it("create carries one_shot_payment_id", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "re_1", object: "refund", one_shot_payment_id: "osp_1" } },
    ]);
    await client(fetchImpl).refunds.create({ one_shot_payment_id: "osp_1", reason: "changed mind" });
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/refunds");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.one_shot_payment_id).toBe("osp_1");
    expect(body.reason).toBe("changed mind");
    expect("payment_id" in body).toBe(false);
  });
});

describe("Disputes: read-only", () => {
  it("retrieve hits /v1/disputes/{id}", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "dp_1", object: "dispute", status: "open" } },
    ]);
    await client(fetchImpl).disputes.retrieve("dp_1");
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/disputes/dp_1");
    expect(calls[0]?.method).toBe("GET");
  });

  it("list hits /v1/disputes", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { object: "list", data: [], has_more: false } },
    ]);
    await client(fetchImpl).disputes.list({ limit: 5 });
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/disputes?limit=5");
  });
});

describe("Subscriptions: reactivate", () => {
  it("posts to /v1/subscriptions/{id}/reactivate", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "sub_1", status: "active" } },
    ]);
    await client(fetchImpl).subscriptions.reactivate("sub_1");
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/subscriptions/sub_1/reactivate");
    expect(calls[0]?.method).toBe("POST");
  });
});

describe("Subscriptions: usage records", () => {
  it("createUsageRecord posts to the nested route with the usage fields", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 201,
        body: {
          id: "ur_1",
          object: "usage_record",
          subscription_id: "sub_1",
          quantity: 42,
          invoice_id: null,
        },
      },
    ]);
    await client(fetchImpl).subscriptions.createUsageRecord("sub_1", {
      quantity: 42,
      occurred_at: 1_700_000_000,
      metadata: { source: "unit" },
    });
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/subscriptions/sub_1/usage_records");
    expect(calls[0]?.method).toBe("POST");
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body).toEqual({
      quantity: 42,
      occurred_at: 1_700_000_000,
      metadata: { source: "unit" },
    });
    // Auto-idempotency wraps the mutating call; usage reporting is
    // exactly the surface where a double-send must not double-bill.
    expect(calls[0]?.headers["idempotency-key"]).toMatch(/^sdk-/);
  });

  it("createUsageRecord threads a caller-supplied idempotency key and omits optionals", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 201, body: { id: "ur_1", object: "usage_record" } },
    ]);
    await client(fetchImpl).subscriptions.createUsageRecord("sub_1", {
      quantity: 1,
      idempotencyKey: "usage-1",
    });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body).toEqual({ quantity: 1 });
    expect("idempotencyKey" in body).toBe(false);
    expect(calls[0]?.headers["idempotency-key"]).toBe("usage-1");
  });

  it("listUsageRecords GETs the nested route with the invoice_id filter", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { object: "list", data: [], has_more: false } },
    ]);
    await client(fetchImpl).subscriptions.listUsageRecords("sub_1", {
      invoice_id: "pending",
      limit: 25,
    });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/subscriptions/sub_1/usage_records");
    expect(url.searchParams.get("invoice_id")).toBe("pending");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(calls[0]?.method).toBe("GET");
  });
});

describe("Prices: usage_type", () => {
  it("carries usage_type in the create body", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "price_1", usage_type: "metered" } },
    ]);
    await client(fetchImpl).prices.create({
      product_id: "prod_api",
      amount_cents: 5,
      currency: "EUR",
      interval: "month",
      usage_type: "metered",
    });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.usage_type).toBe("metered");
  });

  it("omits usage_type when undefined (server defaults to licensed)", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: { id: "price_1" } }]);
    await client(fetchImpl).prices.create({
      product_id: "prod_1",
      amount_cents: 999,
      currency: "EUR",
      interval: "month",
    });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect("usage_type" in body).toBe(false);
  });
});

describe("Prices: refund window override", () => {
  it("carries refund_window_initial_days and renewal in the create body", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 200,
        body: {
          id: "price_1",
          refund_window_initial_days: 14,
          refund_window_renewal_days: 0,
        },
      },
    ]);
    await client(fetchImpl).prices.create({
      product_id: "prod_bundle",
      amount_cents: 1499,
      currency: "EUR",
      interval: "month",
      refund_window_initial_days: 14,
      refund_window_renewal_days: 0,
    });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    // `0` must survive dropUndefined; it's the "refunds disabled
    // for this charge type" signal, distinct from "default applies".
    expect(body.refund_window_initial_days).toBe(14);
    expect(body.refund_window_renewal_days).toBe(0);
  });

  it("omits both override fields when undefined (server applies defaults)", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: { id: "price_1" } }]);
    await client(fetchImpl).prices.create({
      product_id: "prod_1",
      amount_cents: 999,
      currency: "EUR",
      interval: "month",
    });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect("refund_window_initial_days" in body).toBe(false);
    expect("refund_window_renewal_days" in body).toBe(false);
  });
});

describe("WebhookEndpoints deliveries", () => {
  it("listDeliveries uses the nested route", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { object: "list", data: [], has_more: false } },
    ]);
    await client(fetchImpl).webhookEndpoints.listDeliveries("we_1", { limit: 25 });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/webhook_endpoints/we_1/deliveries");
    expect(url.searchParams.get("limit")).toBe("25");
  });

  it("getDelivery fetches one row", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: { id: "wde_1" } }]);
    await client(fetchImpl).webhookEndpoints.getDelivery("we_1", "wde_1");
    expect(calls[0]?.url).toBe(
      "https://test.billkit.eu/v1/webhook_endpoints/we_1/deliveries/wde_1",
    );
    expect(calls[0]?.method).toBe("GET");
  });

  it("redeliver re-enqueues a row idempotently", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "wde_1", status: "pending" } },
    ]);
    await client(fetchImpl).webhookEndpoints.redeliver("we_1", "wde_1", {
      idempotencyKey: "redeliver-1",
    });
    expect(calls[0]?.url).toBe(
      "https://test.billkit.eu/v1/webhook_endpoints/we_1/deliveries/wde_1/redeliver",
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["idempotency-key"]).toBe("redeliver-1");
  });
});

describe("Prices: archive", () => {
  it("update POSTs active:false to /v1/prices/{id} and carries the idempotency key", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "price_1", active: false } },
    ]);
    const archived = await client(fetchImpl).prices.update<{ id: string; active: boolean }>(
      "price_1",
      { active: false, idempotencyKey: "archive-1" },
    );
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/prices/price_1");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["idempotency-key"]).toBe("archive-1");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ active: false });
    expect(archived.active).toBe(false);
  });

  it("auto-generates an idempotency key when none is supplied", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: { id: "price_1" } }]);
    await client(fetchImpl).prices.update("price_1", { active: false });
    expect(calls[0]?.headers["idempotency-key"]).toMatch(/^sdk-/);
  });

  // `active` moves both ways. It decides what new checkouts may buy and
  // nothing else, so neither direction can change what a past charge was
  // made under, which is what price immutability actually protects.
  it("sends active:true to put a price back on sale", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "price_1", active: true } },
    ]);
    const back = await client(fetchImpl).prices.update<{ active: boolean }>("price_1", {
      active: true,
    });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ active: true });
    expect(back.active).toBe(true);
  });
});

describe("DELETE is only for resources that really go away", () => {
  // The catalogue is retired through its update route. The SDK used to
  // carry a `delete()` for each of those, which named a verb the server
  // no longer answers and described an outcome that never happened:
  // every one of those rows stays readable afterwards.
  it("is not exposed on the catalogue resources", () => {
    const c = client(makeMockFetch([]).fetchImpl) as unknown as Record<string, unknown>;
    for (const resource of ["prices", "products", "coupons", "taxRates"]) {
      const target = c[resource] as Record<string, unknown>;
      expect(target.delete, `${resource}.delete should not exist`).toBeUndefined();
      expect(typeof target.update).toBe("function");
    }
  });

  it("is exposed where the object does go away", () => {
    const c = client(makeMockFetch([]).fetchImpl);
    expect(typeof c.customers.delete).toBe("function");
    // A webhook endpoint is configuration, not a record of money, so a
    // mistyped URL is removed rather than disabled forever. Disabling
    // stays beside it as the reversible act.
    expect(typeof c.webhookEndpoints.delete).toBe("function");
    expect(typeof c.webhookEndpoints.update).toBe("function");
  });

  it("sends DELETE to the webhook endpoint path", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "we_1", object: "webhook_endpoint", deleted: true } },
    ]);
    const gone = await client(fetchImpl).webhookEndpoints.delete<{ deleted: boolean }>("we_1", {
      idempotencyKey: "drop-1",
    });
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/webhook_endpoints/we_1");
    expect(calls[0]?.headers["idempotency-key"]).toBe("drop-1");
    expect(gone.deleted).toBe(true);
  });
});

describe("Subscriptions: list filters", () => {
  it("sends renewal_state, the only way to find paused subscriptions", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { object: "list", data: [], has_more: false } },
    ]);
    await client(fetchImpl).subscriptions.list({ renewal_state: "paused" });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/subscriptions");
    expect(url.searchParams.get("renewal_state")).toBe("paused");
    expect(url.searchParams.has("status")).toBe(false);
    expect(calls[0]?.method).toBe("GET");
  });

  it("sends customer_id and a CSV status together", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { object: "list", data: [], has_more: false } },
    ]);
    await client(fetchImpl).subscriptions.list({
      customer_id: "cus_1",
      status: "active,past_due",
      limit: 25,
    });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("customer_id")).toBe("cus_1");
    expect(url.searchParams.get("status")).toBe("active,past_due");
    expect(url.searchParams.get("limit")).toBe("25");
  });

  it("iter carries the filter onto every page request", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 200,
        body: { object: "list", data: [{ id: "sub_1" }], has_more: true },
      },
      { status: 200, body: { object: "list", data: [{ id: "sub_2" }], has_more: false } },
    ]);
    const seen: string[] = [];
    for await (const sub of client(fetchImpl).subscriptions.iter<{ id: string }>({
      renewal_state: "paused",
      pageSize: 1,
    })) {
      seen.push(sub.id);
    }
    expect(seen).toEqual(["sub_1", "sub_2"]);
    for (const call of calls) {
      expect(new URL(call.url).searchParams.get("renewal_state")).toBe("paused");
    }
    // Page 2 still carries the cursor as well as the filter.
    expect(new URL(calls[1]?.url ?? "").searchParams.get("starting_after")).toBe("sub_1");
  });
});

describe("Metered pricing: sub-cent rates, tiers, dedupe, summary", () => {
  it("sends unit_amount_decimal as a JSON string, not a number", async () => {
    // Asserted on the serialised body because the risk is exactly that it
    // travels as a JSON number. A reader parsing `0.02` into a double gets
    // a value that is not 0.02, and the rate is wrong before it has been
    // multiplied by anything.
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "price_1", object: "price", unit_amount_decimal: "0.02" } },
    ]);
    await client(fetchImpl).prices.create({
      product_id: "prod_api",
      currency: "EUR",
      interval: "month",
      usage_type: "metered",
      unit_amount_decimal: "0.02",
    });
    expect(calls[0]?.body).toContain('"unit_amount_decimal":"0.02"');
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.unit_amount_decimal).toBe("0.02");
    // A price priced by the decimal sends no integer amount at all.
    expect("amount_cents" in body).toBe(false);
  });

  it("throws before any request when a decimal rate arrives as a number", async () => {
    // The type forbids it; this is for the callers the type system cannot
    // reach (plain JS, a value that came through `any`, a parsed body).
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: { id: "price_1" } }]);
    await expect(
      client(fetchImpl).prices.create({
        product_id: "prod_api",
        currency: "EUR",
        interval: "month",
        usage_type: "metered",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        unit_amount_decimal: 0.0002 as any,
      }),
    ).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("sends a tier table, including up_to: 'inf' on the last band", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "price_1", object: "price" } },
    ]);
    await client(fetchImpl).prices.create({
      product_id: "prod_api",
      currency: "EUR",
      interval: "month",
      usage_type: "metered",
      billing_scheme: "tiered",
      tiers_mode: "graduated",
      tiers: [
        { up_to: 1000, unit_amount: 1 },
        { up_to: "inf", unit_amount_decimal: "0.5", flat_amount: 500 },
      ],
    });
    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.billing_scheme).toBe("tiered");
    expect(body.tiers_mode).toBe("graduated");
    expect(body.tiers).toEqual([
      { up_to: 1000, unit_amount: 1 },
      { up_to: "inf", unit_amount_decimal: "0.5", flat_amount: 500 },
    ]);
  });

  it("throws when a number rate is hidden inside a tier", async () => {
    // Inside a band is where a rate is most likely to be typed as a bare
    // literal, so the guard has to reach in there too.
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: { id: "price_1" } }]);
    await expect(
      client(fetchImpl).prices.create({
        product_id: "prod_api",
        currency: "EUR",
        interval: "month",
        usage_type: "metered",
        billing_scheme: "tiered",
        tiers_mode: "graduated",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tiers: [{ up_to: "inf", unit_amount_decimal: 0.5 as any }],
      }),
    ).rejects.toThrow(/tiers\[0\]\.unit_amount_decimal/);
    expect(calls).toHaveLength(0);
  });

  it("carries refund_on_cancel on create", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "price_1", refund_on_cancel: "prorated" } },
    ]);
    await client(fetchImpl).prices.create({
      product_id: "prod_1",
      amount_cents: 1499,
      currency: "EUR",
      interval: "month",
      refund_on_cancel: "prorated",
    });
    expect(JSON.parse(calls[0]?.body ?? "{}").refund_on_cancel).toBe("prorated");
  });

  it("carries the usage identifier, the dedupe an Idempotency-Key cannot do", async () => {
    // A job runner replaying its own task sends a NEW request with a NEW
    // key, so only a natural key stops the second report being a second
    // charge.
    const { fetchImpl, calls } = makeMockFetch([
      { status: 201, body: { id: "ur_1", object: "usage_record", identifier: "job-42" } },
    ]);
    await client(fetchImpl).subscriptions.createUsageRecord("sub_1", {
      quantity: 10,
      identifier: "job-42",
    });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ quantity: 10, identifier: "job-42" });
  });

  it("omits identifier when it is not given", async () => {
    // Dedupe is opt-in: two identical reports at different times are
    // legitimately two records.
    const { fetchImpl, calls } = makeMockFetch([{ status: 201, body: { id: "ur_1" } }]);
    await client(fetchImpl).subscriptions.createUsageRecord("sub_1", { quantity: 10 });
    expect("identifier" in JSON.parse(calls[0]?.body ?? "{}")).toBe(false);
  });

  it("retrieveUsageSummary GETs the summary route", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 200,
        body: {
          object: "usage_summary",
          pending_quantity: 3,
          gross_cents: 15,
          will_charge: false,
          minimum_charge_cents: 100,
        },
      },
    ]);
    const summary = await client(fetchImpl).subscriptions.retrieveUsageSummary<{
      will_charge: boolean;
    }>("sub_1");
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/subscriptions/sub_1/usage_summary");
    expect(calls[0]?.method).toBe("GET");
    // The point of the endpoint: EUR 0.15 of usage will not be charged
    // this cycle, and the caller can see that before promising an amount.
    expect(summary.will_charge).toBe(false);
  });
});
