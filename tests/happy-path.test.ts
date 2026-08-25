import { describe, expect, it } from "vitest";

import { BillKit } from "../src/client.js";
import { FAST_RETRY, makeMockFetch } from "./helpers.js";

describe("happy path", () => {
  it("creates a customer with auth + idempotency headers", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "cus_1", object: "customer", email: "a@b.co" } },
    ]);
    const client = new BillKit({
      apiKey: "sk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
    });

    const customer = await client.customers.create<{ id: string }>({
      email: "a@b.co",
      name: "Ada",
    });

    expect(customer.id).toBe("cus_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/customers");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer sk_test_unit");
    expect(calls[0]?.headers["idempotency-key"]).toMatch(/^sdk-/);
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
  });

  it("retrieves a subscription with no Idempotency-Key on GET", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "sub_1", status: "active" } },
    ]);
    const client = new BillKit({
      apiKey: "sk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
    });

    await client.subscriptions.retrieve("sub_1");
    expect(calls[0]?.headers["idempotency-key"]).toBeUndefined();
  });

  it("passes pagination params as query string", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { object: "list", data: [], has_more: false } },
    ]);
    const client = new BillKit({
      apiKey: "sk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
    });

    await client.customers.list({ limit: 25, starting_after: "cus_x" });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("starting_after")).toBe("cus_x");
  });

  it("creates and updates products", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "prod_1", name: "Pro" } },
      { status: 200, body: { id: "prod_1", active: false } },
    ]);
    const client = new BillKit({
      apiKey: "sk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
    });

    const product = await client.products.create<{ id: string }>({
      name: "Pro",
      description: "Hosted billing for SaaS",
      marketing_features: ["Checkout", "Subscriptions"],
    });
    const archived = await client.products.update<{ active: boolean }>("prod_1", {
      active: false,
    });

    expect(product.id).toBe("prod_1");
    expect(archived.active).toBe(false);
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/products");
    expect(JSON.parse(calls[0]?.body ?? "{}").marketing_features).toHaveLength(2);
    expect(JSON.parse(calls[1]?.body ?? "{}").active).toBe(false);
  });

  it("creates prices with product_id and trial fields", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "price_1", product_id: "prod_1" } },
    ]);
    const client = new BillKit({
      apiKey: "sk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
    });

    const price = await client.prices.create<{ id: string }>({
      product_id: "prod_1",
      amount_cents: 999,
      currency: "EUR",
      interval: "month",
      trial_days: 14,
      payment_methods: ["creditcard", "directdebit"],
    });

    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(price.id).toBe("price_1");
    expect(body.product_id).toBe("prod_1");
    expect(body.trial_days).toBe(14);
    expect(body.payment_methods).toEqual(["creditcard", "directdebit"]);
    expect("product_name" in body).toBe(false);
  });

  it("cancel uses POST and carries idempotency", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "sub_1", status: "canceled" } },
    ]);
    const client = new BillKit({
      apiKey: "sk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
    });

    const sub = await client.subscriptions.cancel<{ status: string }>("sub_1");
    expect(sub.status).toBe("canceled");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["idempotency-key"]).toMatch(/^sdk-/);
  });

  it("create refund supports subscription_id and drops undefined", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "re_1" } },
    ]);
    const client = new BillKit({
      apiKey: "sk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
    });

    await client.refunds.create({
      subscription_id: "sub_1",
      reason: "user_requested",
    });

    const body = JSON.parse(calls[0]?.body ?? "{}");
    expect(body.subscription_id).toBe("sub_1");
    expect(body.reason).toBe("user_requested");
    expect("payment_id" in body).toBe(false);
  });

  it("respects a caller-supplied idempotency key", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { id: "cus_1" } },
    ]);
    const client = new BillKit({
      apiKey: "sk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
    });

    await client.customers.create({ email: "a@b.co", idempotencyKey: "my-key" });
    expect(calls[0]?.headers["idempotency-key"]).toBe("my-key");
  });
});
