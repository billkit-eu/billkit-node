import { describe, expect, it } from "vitest";

import { BillKit } from "../src/client.js";
import { APIConnectionError } from "../src/errors.js";
import type { RetryPolicy } from "../src/retry.js";

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
