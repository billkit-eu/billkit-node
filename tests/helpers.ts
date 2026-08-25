/**
 * Test helpers shared across vitest files.
 *
 * `MockTransport` is a fetch impl that returns pre-staged responses
 * in order. Each test stages 1+ responses, runs the SDK code, then
 * asserts on the captured request log. Lighter-weight than spinning
 * up MSW for unit tests; we'll use MSW only for the cross-runtime
 * webhook tests where the full WHATWG fetch surface matters.
 */

import type { RetryPolicy } from "../src/retry.js";

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface StagedResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  error?: Error;
}

export function makeMockFetch(responses: StagedResponse[]): {
  fetchImpl: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const queue = [...responses];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    const initHeaders = init?.headers;
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    } else if (initHeaders && typeof initHeaders === "object") {
      for (const [k, v] of Object.entries(initHeaders as Record<string, string>)) {
        headers[k.toLowerCase()] = String(v);
      }
    }
    calls.push({
      url,
      method,
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    const staged = queue.shift();
    if (!staged) {
      throw new Error(`MockTransport: no staged response for ${method} ${url}`);
    }
    if (staged.error) throw staged.error;

    return new Response(staged.body === undefined ? null : JSON.stringify(staged.body), {
      status: staged.status,
      headers: staged.headers,
    });
  };

  return { fetchImpl, calls };
}

export const FAST_RETRY: RetryPolicy = {
  maxAttempts: 3,
  initialBackoffMs: 0,
  backoffMultiplier: 1,
  maxBackoffMs: 0,
  jitter: 0,
};
