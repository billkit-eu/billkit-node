import { describe, expect, it } from "vitest";

import { BillKit } from "../src/client.js";
import { APIConnectionError } from "../src/errors.js";
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
  it("bounds a stalled body read by timeoutMs", async () => {
    const client = new BillKit({
      apiKey: "bk_test_unit",
      baseUrl: "https://test.billkit.eu",
      timeoutMs: 25,
      retryPolicy: NO_RETRY,
      fetch: stallingBodyFetch(),
    });

    await expect(client.customers.retrieve("cus_1")).rejects.toBeInstanceOf(APIConnectionError);
  });

  it("reports a clear timeout message", async () => {
    const client = new BillKit({
      apiKey: "bk_test_unit",
      baseUrl: "https://test.billkit.eu",
      timeoutMs: 25,
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
      timeoutMs: 25,
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
