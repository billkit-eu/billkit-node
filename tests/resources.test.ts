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
import { FAST_RETRY, makeMockFetch } from "./helpers.js";

function client(fetchImpl: typeof fetch) {
  return new BillKit({
    apiKey: "sk_test_unit",
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
