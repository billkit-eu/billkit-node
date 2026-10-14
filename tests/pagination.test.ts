/**
 * Auto-pagination tests.
 *
 * We assert on:
 *   - The cursor protocol (`starting_after` reset to the last row's id).
 *   - The three terminators: `has_more=false`, empty page, missing id.
 *   - Filter forwarding (audit-log walk by `action`).
 *   - `limit` as the page size, `starting_after` as the starting cursor.
 *   - `iter()` taking exactly the filters `list()` takes, on every resource.
 */

import { describe, expect, it } from "vitest";

import { BillKit } from "../src/client.js";
import { FAST_RETRY, makeMockFetch } from "./helpers.js";

function client(fetchImpl: typeof fetch) {
  return new BillKit({
    apiKey: "bk_test_unit",
    baseUrl: "https://test.billkit.eu",
    retryPolicy: FAST_RETRY,
    fetch: fetchImpl,
  });
}

describe("auto-pagination", () => {
  it("walks pages until has_more is false", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 200,
        body: {
          object: "list",
          data: [{ id: "cus_1" }, { id: "cus_2" }],
          has_more: true,
        },
      },
      {
        status: 200,
        body: {
          object: "list",
          data: [{ id: "cus_3" }],
          has_more: false,
        },
      },
    ]);

    const ids: string[] = [];
    for await (const c of client(fetchImpl).customers.iter<{ id: string }>()) {
      ids.push(c.id);
    }
    expect(ids).toEqual(["cus_1", "cus_2", "cus_3"]);
    expect(calls).toHaveLength(2);

    const url0 = new URL(calls[0]?.url ?? "");
    expect(url0.searchParams.has("starting_after")).toBe(false);

    const url1 = new URL(calls[1]?.url ?? "");
    expect(url1.searchParams.get("starting_after")).toBe("cus_2");
  });

  it("stops on an empty page even if has_more is true", async () => {
    // Defensive against a broken server that contradicts itself.
    // Without this terminator the iterator would loop forever.
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 200,
        body: { object: "list", data: [], has_more: true },
      },
    ]);
    const ids: string[] = [];
    for await (const c of client(fetchImpl).customers.iter<{ id: string }>()) {
      ids.push(c.id);
    }
    expect(ids).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("stops when the last row has no id", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 200,
        body: { object: "list", data: [{}], has_more: true },
      },
    ]);
    const ids: unknown[] = [];
    for await (const c of client(fetchImpl).customers.iter()) {
      ids.push(c);
    }
    expect(ids).toEqual([{}]);
    expect(calls).toHaveLength(1);
  });

  it("uses limit as the page size", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 200,
        body: { object: "list", data: [], has_more: false },
      },
    ]);
    const iter = client(fetchImpl).customers.iter({ limit: 50 });
    for await (const _ of iter) {
      // exhaust
    }
    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("forwards audit-log filters on every page", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 200,
        body: {
          object: "list",
          data: [{ id: "alog_1" }],
          has_more: true,
        },
      },
      {
        status: 200,
        body: { object: "list", data: [{ id: "alog_2" }], has_more: false },
      },
    ]);
    const iter = client(fetchImpl).auditLogs.iter<{ id: string }>({
      action: "customer.created",
      limit: 25,
    });
    const ids: string[] = [];
    for await (const r of iter) ids.push(r.id);

    expect(ids).toEqual(["alog_1", "alog_2"]);
    for (const c of calls) {
      const url = new URL(c.url);
      expect(url.searchParams.get("action")).toBe("customer.created");
      expect(url.searchParams.get("limit")).toBe("25");
    }
    expect(new URL(calls[1]?.url ?? "").searchParams.get("starting_after")).toBe("alog_1");
  });

  it("events.iter forwards type filter", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 200,
        body: { object: "list", data: [], has_more: false },
      },
    ]);
    const iter = client(fetchImpl).events.iter({ type: ["subscription.updated"] });
    for await (const _ of iter) {
      // exhaust
    }
    expect(new URL(calls[0]?.url ?? "").searchParams.get("type")).toBe("subscription.updated");
  });

  it("webhook endpoint deliveries iter scopes to one endpoint", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 200,
        body: { object: "list", data: [{ id: "whd_1" }], has_more: false },
      },
    ]);
    const iter = client(fetchImpl).webhookEndpoints.iterDeliveries<{ id: string }>("we_1");
    const ids: string[] = [];
    for await (const r of iter) ids.push(r.id);
    expect(ids).toEqual(["whd_1"]);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/v1/webhook_endpoints/we_1/deliveries");
  });

  it("starts after the caller's starting_after", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { object: "list", data: [{ id: "cus_9" }], has_more: false } },
    ]);
    for await (const _ of client(fetchImpl).customers.iter({ starting_after: "cus_8" })) {
      // exhaust
    }
    expect(new URL(calls[0]?.url ?? "").searchParams.get("starting_after")).toBe("cus_8");
  });

  it("refuses the 0.x pageSize with a pointer to limit, before any request", async () => {
    const { fetchImpl, calls } = makeMockFetch([]);
    const iter = client(fetchImpl).customers.iter({ pageSize: 5 } as never);
    await expect(iter.next()).rejects.toThrow(/page size is `limit`/);
    expect(calls).toHaveLength(0);
  });
});

/**
 * `iter()` takes exactly what `list()` takes. Every filter of every list
 * route is carried onto the first page and onto the follow-up page, so a
 * filtered walk narrows server-side rather than paging everything. In 0.x
 * several `iter()`s silently dropped filters `list()` honoured.
 */
describe("iter() and list() take the same filters", () => {
  type Walk = (c: ReturnType<typeof client>) => AsyncIterable<unknown>;
  const cases: Array<[string, string, Record<string, string>, Walk]> = [
    ["customers", "/v1/customers", { provisional: "false", expand: "stats" },
      (c) => c.customers.iter({ provisional: false, expand: ["stats"], limit: 2 })],
    ["products", "/v1/products", { expand: "prices,stats" },
      (c) => c.products.iter({ expand: ["prices", "stats"], limit: 2 })],
    ["prices", "/v1/prices", { product_id: "prod_1" },
      (c) => c.prices.iter({ product_id: "prod_1", limit: 2 })],
    ["payments", "/v1/payments", { customer_id: "cus_1", expand: "customer" },
      (c) => c.payments.iter({ customer_id: "cus_1", expand: ["customer"], limit: 2 })],
    ["oneShotPayments", "/v1/checkout/one_shot", { customer_id: "cus_1", status: "paid" },
      (c) => c.oneShotPayments.iter({ customer_id: "cus_1", status: "paid", limit: 2 })],
    ["invoices", "/v1/invoices",
      { customer_id: "cus_1", subscription_id: "sub_1", payment_id: "pay_1", status: "paid", expand: "customer" },
      (c) => c.invoices.iter({ customer_id: "cus_1", subscription_id: "sub_1", payment_id: "pay_1", status: "paid", expand: ["customer"], limit: 2 })],
    ["disputes", "/v1/disputes", { status: "open,won", payment_id: "pay_1" },
      (c) => c.disputes.iter({ status: ["open", "won"], payment_id: "pay_1", limit: 2 })],
    ["subscriptions", "/v1/subscriptions",
      { customer_id: "cus_1", status: "active,past_due", renewal_state: "paused", expand: "price" },
      (c) => c.subscriptions.iter({ customer_id: "cus_1", status: ["active", "past_due"], renewal_state: ["paused"], expand: ["price"], limit: 2 })],
    ["usage records", "/v1/subscriptions/sub_1/usage_records", { invoice_id: "pending" },
      (c) => c.subscriptions.iterUsageRecords("sub_1", { invoice_id: "pending", limit: 2 })],
    ["events", "/v1/events", { type: "invoice.paid,invoice.voided", expand: "customer" },
      (c) => c.events.iter({ type: ["invoice.paid", "invoice.voided"], expand: ["customer"], limit: 2 })],
    ["auditLogs", "/v1/audit_logs",
      { action: "customer.created", resource_type: "customer", resource_id: "cus_1", actor_id: "op_1" },
      (c) => c.auditLogs.iter({ action: "customer.created", resource_type: "customer", resource_id: "cus_1", actor_id: "op_1", limit: 2 })],
    ["creditNotes", "/v1/credit_notes", { invoice_id: "inv_1", customer_id: "cus_1" },
      (c) => c.creditNotes.iter({ invoice_id: "inv_1", customer_id: "cus_1", limit: 2 })],
  ];

  it.each(cases)("%s", async (_name, path, filters, walk) => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { object: "list", data: [{ id: "x_1" }], has_more: true } },
      { status: 200, body: { object: "list", data: [{ id: "x_2" }], has_more: false } },
    ]);
    const seen: unknown[] = [];
    for await (const row of walk(client(fetchImpl))) seen.push(row);
    expect(seen).toHaveLength(2);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const url = new URL(call.url);
      expect(url.pathname).toBe(path);
      expect(url.searchParams.get("limit")).toBe("2");
      for (const [key, value] of Object.entries(filters)) {
        expect(url.searchParams.get(key), key).toBe(value);
      }
    }
    expect(new URL(calls[1]!.url).searchParams.get("starting_after")).toBe("x_1");
  });
});
