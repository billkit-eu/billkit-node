/**
 * Argument checking at the edges of the 1.0 surface:
 *
 * - request options: an `undefined` value is absent whatever its key, a
 *   defined unknown key is refused, and so is a superset object;
 * - client options: an unknown key is refused, `timeoutMs` with the 1.0 name,
 *   and an explicit empty `apiKey` is refused rather than read as "use the
 *   environment";
 * - the parameters slot: a call the API takes no parameters for refuses any
 *   key, a request option in the parameters is refused with a hint, and an
 *   empty `expand` is not sent;
 * - `headers` cannot replace a header the SDK owns, and values are strings;
 * - a body that fails after the headers surfaces as `APIConnectionError`;
 * - `isKnownEventType` takes an event as well as a type string.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { BillKit } from "../src/client.js";
import { APIConnectionError, BillKitError } from "../src/errors.js";
import { isKnownEventType } from "../src/eventTypes.js";
import type { RequestOptions } from "../src/transport.js";
import { FAST_RETRY, makeMockFetch } from "./helpers.js";

function client(fetchImpl: typeof fetch) {
  return new BillKit({
    apiKey: "bk_test_unit",
    baseUrl: "https://test.billkit.eu",
    retryPolicy: FAST_RETRY,
    fetch: fetchImpl,
  });
}

describe("request options", () => {
  it("treats a key whose value is undefined as absent, known or not", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: { id: "cus_1" } }]);
    const signal = new AbortController().signal;
    await client(fetchImpl).customers.retrieve("cus_1", {}, {
      signal,
      foo: undefined,
    } as RequestOptions);
    expect(calls).toHaveLength(1);
  });

  it("lets a spread with idempotencyKey: undefined through, and generates a key", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);
    const params = { email: "a@b.co" };
    await client(fetchImpl).customers.create({ ...params, idempotencyKey: undefined } as never);
    await client(fetchImpl).customers.create(params, { idempotencyKey: undefined });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(JSON.parse(call.body!)).toEqual({ email: "a@b.co" });
      expect(call.headers["idempotency-key"]).toMatch(/^sdk-/);
    }
  });

  it("lets iter() take pageSize: undefined", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { object: "list", data: [], has_more: false } },
    ]);
    for await (const row of client(fetchImpl).customers.iter({ pageSize: undefined } as never)) {
      void row;
    }
    expect(calls).toHaveLength(1);
  });

  it("still refuses an unknown key with a defined value, and a superset object", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: {} }]);
    await expect(
      client(fetchImpl).customers.retrieve("cus_1", {}, { foo: 1 } as RequestOptions),
    ).rejects.toThrow(/"foo" is not a request option/);
    const appConfig = { timeout: 5_000, region: "eu" };
    await expect(
      client(fetchImpl).customers.retrieve("cus_1", {}, appConfig as RequestOptions),
    ).rejects.toThrow(/"region" is not a request option/);
    expect(calls).toHaveLength(0);
  });
});

describe("client options", () => {
  it("refuses timeoutMs with the 1.0 name", () => {
    expect(() => new BillKit({ apiKey: "bk_test_unit", timeoutMs: 5_000 } as never)).toThrow(
      /"timeoutMs" is not a client option: use timeout \(milliseconds\)/,
    );
  });

  it("refuses any other unknown key, naming the real ones", () => {
    expect(() => new BillKit({ apiKey: "bk_test_unit", retries: 2 } as never)).toThrow(
      /"retries" is not a client option: Client options are apiKey, baseUrl, timeout, maxRetries/,
    );
  });

  it("ignores an unknown key whose value is undefined", () => {
    expect(
      () => new BillKit({ apiKey: "bk_test_unit", timeoutMs: undefined } as never),
    ).not.toThrow();
  });
});

describe("the api key", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to BILLKIT_API_KEY only when apiKey is left out", async () => {
    vi.stubEnv("BILLKIT_API_KEY", "bk_test_from_env");
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: {} }]);
    await new BillKit({ fetch: fetchImpl, apiKey: undefined }).customers.retrieve("cus_1");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer bk_test_from_env");
  });

  it.each(["", "   "])("refuses an explicit empty apiKey %j, even with the variable set", (key) => {
    vi.stubEnv("BILLKIT_API_KEY", "bk_live_from_env");
    expect(() => new BillKit({ apiKey: key })).toThrow(/apiKey is empty/);
  });

  it("refuses an apiKey that is not a string", () => {
    expect(() => new BillKit({ apiKey: 42 } as never)).toThrow(/apiKey must be a string/);
  });
});

describe("the parameters slot", () => {
  it("sends no body for a call that takes no parameters, given {} or nothing", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);
    await client(fetchImpl).subscriptions.cancel("sub_1");
    await client(fetchImpl).subscriptions.cancel("sub_1", {}, { idempotencyKey: "c-1" });
    expect(calls.map((c) => c.body)).toEqual([undefined, undefined]);
    expect(calls[1]?.headers["idempotency-key"]).toBe("c-1");
  });

  it("refuses a request option where the parameters go, naming the fix", async () => {
    const { fetchImpl, calls } = makeMockFetch([]);
    await expect(
      client(fetchImpl).subscriptions.cancel("sub_1", { timeout: 5_000 } as never),
    ).rejects.toThrow(/"timeout" is a request option, and request options are the last argument/);
    await expect(
      client(fetchImpl).tenant.export({ signal: AbortSignal.timeout(1_000) } as never),
    ).rejects.toThrow(/"signal" is a request option/);
    await expect(
      client(fetchImpl).invoices.retrievePdf("in_1", { maxRetries: 0 } as never),
    ).rejects.toThrow(/"maxRetries" is a request option/);
    await expect(
      client(fetchImpl).customers.delete("cus_1", { idempotencyKey: "d-1" } as never),
    ).rejects.toThrow(/"idempotencyKey" is a request option/);
    expect(calls).toHaveLength(0);
  });

  it("refuses any key on a call that takes no parameters, rather than dropping it", async () => {
    const { fetchImpl, calls } = makeMockFetch([]);
    await expect(
      client(fetchImpl).invoices.sendEmail("in_1", { to: "a@b.co" } as never),
    ).rejects.toThrow(/this call takes no parameters, so "to" cannot be sent/);
    await expect(
      client(fetchImpl).apiKeys.revoke("ak_1", "now" as never),
    ).rejects.toThrow(/parameters must be an object/);
    expect(calls).toHaveLength(0);
  });

  it("lets a key whose value is undefined through as absent", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: {} }]);
    await client(fetchImpl).apiKeys.revoke("ak_1", { timeout: undefined } as never);
    expect(calls).toHaveLength(1);
  });

  it("refuses a request option inside real parameters too", async () => {
    const { fetchImpl, calls } = makeMockFetch([]);
    await expect(
      client(fetchImpl).products.retrieve("prod_1", { timeout: 5_000 } as never),
    ).rejects.toThrow(/"timeout" is a request option, not a parameter/);
    await expect(
      client(fetchImpl).customers.list({ limit: 1, headers: { "X-A": "b" } } as never),
    ).rejects.toThrow(/"headers" is a request option, not a parameter/);
    expect(calls).toHaveLength(0);
  });

  it("does not send an empty expand, which the API would refuse", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: {} },
      { status: 200, body: { object: "list", data: [], has_more: false } },
      { status: 200, body: {} },
    ]);
    await client(fetchImpl).products.retrieve("prod_1", { expand: [] });
    await client(fetchImpl).customers.list({ expand: [], limit: 2 });
    await client(fetchImpl).products.retrieve("prod_1", { expand: ["prices", "stats"] });
    expect(calls.map((c) => c.url)).toEqual([
      "https://test.billkit.eu/v1/products/prod_1",
      "https://test.billkit.eu/v1/customers?limit=2",
      "https://test.billkit.eu/v1/products/prod_1?expand=prices%2Cstats",
    ]);
  });
});

describe("headers cannot replace what the SDK owns", () => {
  it.each(["Authorization", "authorization", "Idempotency-Key", "IDEMPOTENCY-KEY", "Content-Type", "user-agent"])(
    "refuses %s before any request",
    async (name) => {
      const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: {} }]);
      const err = await client(fetchImpl)
        .customers.create({ email: "a@b.co" }, { headers: { [name]: "x" } })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message).toContain(`"${name}", which the SDK owns`);
      expect((err as Error).message).toContain("idempotencyKey");
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    ["a number", 1],
    ["null", null],
    ["an object", { a: 1 }],
  ])("refuses %s as a header value", async (_label, value) => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: {} }]);
    await expect(
      client(fetchImpl).customers.retrieve("cus_1", {}, { headers: { "X-Trace": value } } as never),
    ).rejects.toThrow(/header "X-Trace" must be a string/);
    expect(calls).toHaveLength(0);
  });

  it("sends other headers and skips an undefined value", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: {} }]);
    await client(fetchImpl).customers.retrieve("cus_1", {}, {
      headers: { "X-Trace": "abc", "X-Optional": undefined },
    });
    expect(calls[0]?.headers["x-trace"]).toBe("abc");
    expect(calls[0]?.headers).not.toHaveProperty("x-optional");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer bk_test_unit");
  });
});

/** A 200 whose body sends one chunk and then fails the way undici does. */
function failingBodyFetch(failure: unknown): typeof fetch {
  return async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"billkit_export_version":'));
      },
      pull(controller) {
        controller.error(failure);
      },
    });
    return new Response(body, { status: 200 });
  };
}

describe("tenant.export after the headers", () => {
  it("surfaces a mid-body failure as APIConnectionError, with the cause", async () => {
    const terminated = new TypeError("terminated");
    const stream = await client(failingBodyFetch(terminated)).tenant.export();
    const reader = stream.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('{"billkit_export_version":');
    const err = await reader.read().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err).toBeInstanceOf(BillKitError);
    expect((err as Error).message).toMatch(/while the response body was being read \(terminated\)/);
    expect((err as Error).cause).toBe(terminated);
  });

  it("errors with the signal's reason when the caller aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    const stream = await client(failingBodyFetch(new DOMException("aborted", "AbortError")))
      .tenant.export({}, { signal: controller.signal });
    const reader = stream.getReader();
    await reader.read();
    controller.abort(reason);
    await expect(reader.read()).rejects.toBe(reason);
  });

  it("passes a healthy body through unchanged", async () => {
    const { fetchImpl } = makeMockFetch([{ status: 200, body: { billkit_export_version: 2 } }]);
    const stream = await client(fetchImpl).tenant.export();
    expect(JSON.parse(await new Response(stream).text())).toEqual({ billkit_export_version: 2 });
  });
});

describe("isKnownEventType", () => {
  it("takes a verified event as well as a type string", () => {
    expect(isKnownEventType({ type: "invoice.paid" })).toBe(true);
    expect(isKnownEventType({ type: "invoice.something_new" })).toBe(false);
    expect(isKnownEventType("invoice.paid")).toBe(true);
    expect(isKnownEventType({} as never)).toBe(false);
  });
});
