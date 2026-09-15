import { describe, expect, it } from "vitest";

import { BillKit } from "../src/client.js";
import {
  AuthenticationError,
  ConflictError,
  RateLimitError,
  ServerError,
} from "../src/errors.js";
import { FAST_RETRY, makeMockFetch } from "./helpers.js";

describe("retry", () => {
  it("retries 5xx then succeeds", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 503, body: { error: { type: "api_error", message: "down" } } },
      { status: 503, body: { error: { type: "api_error", message: "still" } } },
      { status: 200, body: { id: "cus_1" } },
    ]);
    const client = new BillKit({
      apiKey: "bk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
    });

    const customer = await client.customers.create<{ id: string }>({ email: "a@b.co" });
    expect(customer.id).toBe("cus_1");
    expect(calls).toHaveLength(3);
  });

  it("exhausts retry budget then raises", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 500, body: { error: { type: "api_error", message: "boom" } } },
      { status: 500, body: { error: { type: "api_error", message: "boom" } } },
      { status: 500, body: { error: { type: "api_error", message: "boom" } } },
    ]);
    const client = new BillKit({
      apiKey: "bk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
    });

    await expect(client.customers.create({ email: "a@b.co" })).rejects.toBeInstanceOf(
      ServerError,
    );
    expect(calls).toHaveLength(3);
  });

  it("never retries 4xx", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 401,
        body: { error: { type: "authentication_error", message: "bad" } },
      },
    ]);
    const client = new BillKit({
      apiKey: "bk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
    });

    await expect(client.customers.retrieve("cus_1")).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    expect(calls).toHaveLength(1);
  });

  it("retries 429 when Retry-After is short", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 429,
        headers: { "Retry-After": "0" },
        body: { error: { type: "rate_limit_error", message: "slow down" } },
      },
      { status: 200, body: { id: "cus_1" } },
    ]);
    const client = new BillKit({
      apiKey: "bk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
    });

    const customer = await client.customers.create<{ id: string }>({ email: "a@b.co" });

    expect(customer.id).toBe("cus_1");
    expect(calls).toHaveLength(2);
  });

  it("does not retry 429 without Retry-After", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 429,
        body: { error: { type: "rate_limit_error", message: "slow down" } },
      },
    ]);
    const client = new BillKit({
      apiKey: "bk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
    });

    await expect(client.customers.create({ email: "a@b.co" })).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(calls).toHaveLength(1);
  });

  it("retries 409 idempotency_in_progress then returns the replayed result", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 409,
        headers: { "Retry-After": "1" },
        body: {
          error: {
            type: "conflict",
            code: "idempotency_in_progress",
            message: "A request with the same Idempotency-Key is currently in progress.",
          },
        },
      },
      { status: 200, body: { id: "cus_1" } },
    ]);
    const client = new BillKit({
      apiKey: "bk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
    });

    const customer = await client.customers.create<{ id: string }>({ email: "a@b.co" });

    expect(customer.id).toBe("cus_1");
    expect(calls).toHaveLength(2);
    // The whole reason retrying is safe: same key, so the second call is
    // a replay of the first rather than a second charge.
    expect(calls[0]?.headers["idempotency-key"]).toBe(calls[1]?.headers["idempotency-key"]);
  });

  it("does not retry a 409 with any other code", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 409,
        body: {
          error: {
            type: "conflict",
            code: "idempotency_key_in_use",
            message: "different body",
          },
        },
      },
    ]);
    const client = new BillKit({
      apiKey: "bk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
    });

    await expect(client.customers.create({ email: "a@b.co" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(calls).toHaveLength(1);
  });

  it("bounds idempotency_in_progress retries by maxAttempts", async () => {
    const inProgress = {
      status: 409,
      body: {
        error: { type: "conflict", code: "idempotency_in_progress", message: "in flight" },
      },
    };
    const { fetchImpl, calls } = makeMockFetch([inProgress, inProgress, inProgress]);
    const client = new BillKit({
      apiKey: "bk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
    });

    await expect(client.customers.create({ email: "a@b.co" })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(calls).toHaveLength(FAST_RETRY.maxAttempts);
  });

  it("Idempotency-Key is stable across retries", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 503, body: { error: { type: "api_error", message: "x" } } },
      { status: 200, body: { id: "cus_1" } },
    ]);
    const client = new BillKit({
      apiKey: "bk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
    });

    await client.customers.create({ email: "a@b.co" });
    const k1 = calls[0]?.headers["idempotency-key"];
    const k2 = calls[1]?.headers["idempotency-key"];
    expect(k1).toBeDefined();
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^sdk-/);
  });
});
