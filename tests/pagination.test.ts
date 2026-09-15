/**
 * Auto-pagination tests.
 *
 * We assert on:
 *   - The cursor protocol (`starting_after` reset to the last row's id).
 *   - The three terminators: `has_more=false`, empty page, missing id.
 *   - Filter forwarding (audit-log walk by `action`).
 *   - `pageSize` mapping to `limit`.
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

  it("forwards pageSize as limit", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 200,
        body: { object: "list", data: [], has_more: false },
      },
    ]);
    const iter = client(fetchImpl).customers.iter({ pageSize: 50 });
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
      pageSize: 25,
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
    const iter = client(fetchImpl).events.iter({ type: "subscription.updated" });
    for await (const _ of iter) {
      // exhaust
    }
    expect(new URL(calls[0]?.url ?? "").searchParams.get("type")).toBe("subscription.updated");
  });

  it("webhook endpoint deliveries iter scopes to one endpoint", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 200,
        body: { object: "list", data: [{ id: "wde_1" }], has_more: false },
      },
    ]);
    const iter = client(fetchImpl).webhookEndpoints.iterDeliveries<{ id: string }>("we_1");
    const ids: string[] = [];
    for await (const r of iter) ids.push(r.id);
    expect(ids).toEqual(["wde_1"]);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/v1/webhook_endpoints/we_1/deliveries");
  });
});
