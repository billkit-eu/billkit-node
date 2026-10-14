import { describe, expect, it } from "vitest";

import { BillKit } from "../src/client.js";
import { APIConnectionError, APIError, APITimeoutError, ServerError } from "../src/errors.js";
import type { RetryPolicy } from "../src/retry.js";
import { makeMockFetch } from "./helpers.js";

const NO_RETRY: RetryPolicy = {
  maxAttempts: 1,
  initialBackoffMs: 0,
  backoffMultiplier: 1,
  maxBackoffMs: 0,
  jitter: 0,
};

/**
 * A fetch that resolves the *headers* immediately but whose body never
 * completes; it errors the response stream only when the request's
 * abort signal fires. This is exactly the "server streamed headers then
 * stalled the body" case the old transport did not bound (it cleared the
 * timeout before reading the body, so `response.text()` hung forever).
 */
function stallingBodyFetch(): typeof fetch {
  return async (_url, init) => {
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => {
          controller.error(
            (signal as AbortSignal).reason ?? new DOMException("aborted", "AbortError"),
          );
        });
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("transport timeout", () => {
  it("bounds a stalled body read by the timeout", async () => {
    const client = new BillKit({
      apiKey: "bk_test_unit",
      baseUrl: "https://test.billkit.eu",
      timeout: 25,
      retryPolicy: NO_RETRY,
      fetch: stallingBodyFetch(),
    });

    const err = await client.customers.retrieve("cus_1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APITimeoutError);
    expect(err).toBeInstanceOf(APIConnectionError);
  });

  it("reports a clear timeout message", async () => {
    const client = new BillKit({
      apiKey: "bk_test_unit",
      baseUrl: "https://test.billkit.eu",
      timeout: 25,
      retryPolicy: NO_RETRY,
      fetch: stallingBodyFetch(),
    });

    await expect(client.customers.retrieve("cus_1")).rejects.toThrow(/timed out after 25ms/);
  });
});

describe("APIConnectionError carries the original error as `cause`", () => {
  it("keeps the fetch failure that actually happened", async () => {
    // Node's fetch reports every transport failure as "fetch failed" and
    // puts the real reason in its own cause, so dropping ours left the
    // caller with nothing to diagnose.
    const underlying = new TypeError("fetch failed");
    const { fetchImpl } = makeMockFetch([{ status: 0, error: underlying }]);
    const client = new BillKit({
      apiKey: "bk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: NO_RETRY,
      fetch: fetchImpl,
    });

    const err = await client.customers.retrieve("cus_1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect((err as Error).cause).toBe(underlying);
  });

  it("keeps it on the timeout path too, message unchanged", async () => {
    const client = new BillKit({
      apiKey: "bk_test_unit",
      baseUrl: "https://test.billkit.eu",
      timeout: 25,
      retryPolicy: NO_RETRY,
      fetch: stallingBodyFetch(),
    });

    const err = await client.customers.retrieve("cus_1").catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/timed out after 25ms/);
    expect((err as Error).cause).toBeDefined();
  });

  it("leaves `cause` unset on an error the API actually answered", async () => {
    const { fetchImpl } = makeMockFetch([
      { status: 404, body: { error: { type: "invalid_request_error", message: "nope" } } },
    ]);
    const client = new BillKit({
      apiKey: "bk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: NO_RETRY,
      fetch: fetchImpl,
    });

    const err = await client.customers.retrieve("cus_1").catch((e: unknown) => e);
    expect("cause" in (err as object)).toBe(false);
  });
});

function okClient(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new BillKit({
    apiKey: "bk_test_unit",
    baseUrl: "https://test.billkit.eu",
    retryPolicy: { ...NO_RETRY, maxAttempts: 4 },
    fetch: fetchImpl,
    ...extra,
  });
}

describe("a 2xx the SDK cannot read", () => {
  // 0.x resolved these to `undefined`, so the caller's next line read a
  // field off nothing, far from the cause. A proxy or captive portal
  // answering 200 in BillKit's place is the usual source.
  it("rejects a non-JSON 200 with APIError carrying the text", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("<html>welcome to the hotel wifi</html>", {
        status: 200,
        headers: { "x-request-id": "req_html" },
      });
    const err = await okClient(fetchImpl).customers.retrieve("cus_1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).statusCode).toBe(200);
    expect((err as APIError).rawBody).toBe("<html>welcome to the hotel wifi</html>");
    expect((err as APIError).requestId).toBe("req_html");
    expect((err as Error).message).toMatch(/not JSON/);
  });

  it("rejects an empty 200 the same way", async () => {
    const { fetchImpl } = makeMockFetch([{ status: 200 }]);
    const err = await okClient(fetchImpl).customers.retrieve("cus_1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as Error).message).toMatch(/empty/);
  });

  it("does not retry it", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async () => {
      n += 1;
      return new Response("not json", { status: 200 });
    };
    await okClient(fetchImpl).customers.retrieve("cus_1").catch(() => undefined);
    expect(n).toBe(1);
  });
});

describe("per-request options", () => {
  const BAD_GATEWAY = { status: 502, body: { error: { type: "api_error", message: "x" } } };

  it("maxRetries overrides the client's retry budget for one call", async () => {
    const { fetchImpl, calls } = makeMockFetch([BAD_GATEWAY, BAD_GATEWAY, BAD_GATEWAY]);
    const err = await okClient(fetchImpl)
      .customers.retrieve("cus_1", {}, { maxRetries: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerError);
    expect(calls).toHaveLength(2);
  });

  it("maxRetries: 0 makes exactly one attempt", async () => {
    const { fetchImpl, calls } = makeMockFetch([BAD_GATEWAY, BAD_GATEWAY]);
    await okClient(fetchImpl).customers.retrieve("cus_1", {}, { maxRetries: 0 }).catch(() => undefined);
    expect(calls).toHaveLength(1);
  });

  it("the client-level maxRetries is the default for every call", async () => {
    const { fetchImpl, calls } = makeMockFetch([BAD_GATEWAY, BAD_GATEWAY, BAD_GATEWAY]);
    await okClient(fetchImpl, { maxRetries: 2 }).customers.retrieve("cus_1").catch(() => undefined);
    expect(calls).toHaveLength(3);
  });

  it("timeout overrides the client's for one call", async () => {
    const client = okClient(stallingBodyFetch(), { timeout: 60_000, retryPolicy: NO_RETRY });
    const err = await client.customers.retrieve("cus_1", {}, { timeout: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APITimeoutError);
    expect((err as Error).message).toMatch(/after 20ms/);
  });

  it("headers are sent, after the SDK's own", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: { id: "cus_1" } }]);
    await okClient(fetchImpl).customers.retrieve("cus_1", {}, {
      headers: { "X-Trace": "abc", Accept: "application/json; charset=utf-8" },
    });
    expect(calls[0]?.headers["x-trace"]).toBe("abc");
    expect(calls[0]?.headers["accept"]).toBe("application/json; charset=utf-8");
  });

  it("refuses idempotencyKey left in the parameters, before any request", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: {} }]);
    await expect(
      okClient(fetchImpl).customers.create({ email: "a@b.co", idempotencyKey: "k" } as never),
    ).rejects.toThrow(/belongs in the request options/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a key that is not a request option", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: {} }]);
    await expect(
      okClient(fetchImpl).subscriptions.cancel("sub_1", {}, { reason: "x" } as never),
    ).rejects.toThrow(/"reason" is not a request option/);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["timeout", { timeout: 0 }],
    ["timeout", { timeout: -5 }],
    ["maxRetries", { maxRetries: -1 }],
    ["maxRetries", { maxRetries: 1.5 }],
  ])("refuses a nonsensical %s", async (_name, options) => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: {} }]);
    await expect(okClient(fetchImpl).customers.retrieve("cus_1", {}, options)).rejects.toThrow(
      TypeError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("AbortSignal", () => {
  it("rejects with the signal's reason and sends nothing when already aborted", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: {} }]);
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    controller.abort(reason);
    const err = await okClient(fetchImpl)
      .customers.retrieve("cus_1", {}, { signal: controller.signal })
      .catch((e: unknown) => e);
    expect(err).toBe(reason);
    expect(calls).toHaveLength(0);
  });

  it("aborts an in-flight request and does not retry it", async () => {
    let attempts = 0;
    const controller = new AbortController();
    const fetchImpl: typeof fetch = (_url, init) => {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    };
    const pending = okClient(fetchImpl, { retryPolicy: { ...NO_RETRY, maxAttempts: 4 } })
      .customers.retrieve("cus_1", {}, { signal: controller.signal })
      .catch((e: unknown) => e);
    setTimeout(() => controller.abort(), 10);
    const err = await pending;
    expect((err as Error).name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(APIConnectionError);
    expect(attempts).toBe(1);
  });

  it("is the abort, not a connection error, even with no retries left", async () => {
    const controller = new AbortController();
    const warnings: string[] = [];
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const pending = okClient(fetchImpl, {
      logger: { debug: () => undefined, warn: (m: string) => warnings.push(m) },
    })
      .customers.retrieve("cus_1", {}, { signal: controller.signal, maxRetries: 0 })
      .catch((e: unknown) => e);
    setTimeout(() => controller.abort(), 10);
    const err = await pending;
    expect((err as Error).name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(APIConnectionError);
    // Nothing to retry, so nothing to warn about.
    expect(warnings).toEqual([]);
  });

  it("cuts a retry backoff short", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 503, body: { error: { message: "down" } } },
      { status: 200, body: {} },
    ]);
    const controller = new AbortController();
    const client = okClient(fetchImpl, {
      retryPolicy: { ...NO_RETRY, maxAttempts: 2, initialBackoffMs: 60_000, maxBackoffMs: 60_000 },
    });
    const started = Date.now();
    const pending = client.customers
      .retrieve("cus_1", {}, { signal: controller.signal })
      .catch((e: unknown) => e);
    setTimeout(() => controller.abort(), 20);
    const err = await pending;
    expect((err as Error).name).toBe("AbortError");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls).toHaveLength(1);
  });
});
