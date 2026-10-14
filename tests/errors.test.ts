import { describe, expect, it } from "vitest";

import { BillKit } from "../src/client.js";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  BillKitError,
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  PaymentError,
  PermissionDeniedError,
  RateLimitError,
  ServerError,
  WebhookVerificationError,
} from "../src/errors.js";
import type { RetryPolicy } from "../src/retry.js";
import { FAST_RETRY, makeMockFetch } from "./helpers.js";

function client(fetchImpl: typeof fetch, retryPolicy: RetryPolicy = FAST_RETRY) {
  return new BillKit({
    apiKey: "bk_test_unit",
    baseUrl: "https://test.billkit.eu",
    retryPolicy,
    fetch: fetchImpl,
  });
}

describe("error mapping", () => {
  it("401 -> AuthenticationError", async () => {
    const { fetchImpl } = makeMockFetch([
      {
        status: 401,
        body: { error: { type: "authentication_error", message: "no key" } },
      },
    ]);
    await expect(client(fetchImpl).customers.retrieve("cus_1")).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it("403 -> PermissionDeniedError", async () => {
    const { fetchImpl } = makeMockFetch([
      {
        status: 403,
        body: { error: { type: "permission_error", message: "no scope" } },
      },
    ]);
    await expect(client(fetchImpl).customers.retrieve("cus_1")).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it("404 -> NotFoundError", async () => {
    const { fetchImpl } = makeMockFetch([
      {
        status: 404,
        body: { error: { type: "invalid_request_error", message: "no such" } },
      },
    ]);
    await expect(client(fetchImpl).customers.retrieve("cus_x")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("409 -> ConflictError", async () => {
    const { fetchImpl } = makeMockFetch([
      {
        status: 409,
        body: {
          error: {
            type: "idempotency_error",
            code: "idempotency_key_in_use",
            message: "different body",
          },
        },
      },
    ]);
    try {
      await client(fetchImpl).customers.create({ email: "a@b.co" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).code).toBe("idempotency_key_in_use");
    }
  });

  it("422 -> InvalidRequestError carries param", async () => {
    const { fetchImpl } = makeMockFetch([
      {
        status: 422,
        body: {
          error: {
            type: "invalid_request_error",
            param: "email",
            message: "bad",
          },
        },
      },
    ]);
    try {
      await client(fetchImpl).customers.create({ email: "x" });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidRequestError);
      expect((err as InvalidRequestError).param).toBe("email");
    }
  });

  it("carries the envelope's reason", async () => {
    const pending = {
      status: 409,
      body: {
        error: {
          type: "conflict_error",
          code: "operation_pending",
          reason: "renewal_processing",
          message: "A renewal payment is processing for this subscription.",
        },
      },
    };
    const { fetchImpl } = makeMockFetch([pending, pending, pending, pending, pending]);
    try {
      await client(fetchImpl).subscriptions.cancel("sub_1");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError);
      expect((err as ConflictError).code).toBe("operation_pending");
      expect((err as ConflictError).reason).toBe("renewal_processing");
    }
  });

  it("reason is undefined when the envelope has none", async () => {
    const { fetchImpl } = makeMockFetch([
      { status: 422, body: { error: { type: "invalid_request_error", message: "bad" } } },
    ]);
    const err = await client(fetchImpl)
      .customers.create({ email: "x" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidRequestError);
    expect((err as InvalidRequestError).reason).toBeUndefined();
  });

  it("429 -> RateLimitError carries retryAfter", async () => {
    const { fetchImpl } = makeMockFetch([
      {
        status: 429,
        body: { error: { type: "rate_limit_error", message: "slow" } },
        headers: { "retry-after": "2" },
      },
    ]);
    try {
      await client(fetchImpl, { ...FAST_RETRY, maxAttempts: 1 }).customers.retrieve(
        "cus_1",
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfter).toBe(2);
    }
  });

  it("404 route_not_found (type invalid_request_error) -> NotFoundError", async () => {
    // The envelope the API sends for a path no route matches. Its `type`
    // names the invalid-request family, but the status says 404, and the
    // status decides.
    const { fetchImpl } = makeMockFetch([
      {
        status: 404,
        body: {
          error: {
            type: "invalid_request_error",
            code: "route_not_found",
            message: "Unrecognized request URL.",
          },
        },
      },
    ]);
    const err = await client(fetchImpl)
      .customers.retrieve("cus_1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).not.toBeInstanceOf(InvalidRequestError);
    expect((err as NotFoundError).type).toBe("invalid_request_error");
    expect((err as NotFoundError).code).toBe("route_not_found");
  });

  it("404 whose body says api_error -> NotFoundError, never ServerError", async () => {
    // What the API sent for an unmatched route before 1.0, and what a
    // proxy in front of it can still send: `type: api_error` on a 404.
    // Mapping on `type` made that a ServerError, blaming BillKit for the
    // caller's typo, and ServerError is the class alerting and retry
    // policies key on.
    const { fetchImpl } = makeMockFetch([
      {
        status: 404,
        body: {
          error: { type: "api_error", code: "unhandled", message: "Not Found" },
        },
      },
    ]);
    try {
      await client(fetchImpl).customers.retrieve("cus_typo");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect(err).not.toBeInstanceOf(ServerError);
      // The envelope's own type is still preserved for callers who want it.
      expect((err as NotFoundError).type).toBe("api_error");
      expect((err as NotFoundError).code).toBe("unhandled");
    }
  });

  it("405 method_not_allowed -> InvalidRequestError", async () => {
    const { fetchImpl } = makeMockFetch([
      {
        status: 405,
        body: {
          error: {
            type: "invalid_request_error",
            code: "method_not_allowed",
            message: "Method Not Allowed",
          },
        },
      },
    ]);
    const err = await client(fetchImpl)
      .customers.retrieve("cus_1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidRequestError);
    expect(err).not.toBeInstanceOf(ServerError);
  });

  it("402 payment_refused -> PaymentError, its own class and not retried", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      {
        status: 402,
        body: {
          error: {
            type: "payment_error",
            code: "payment_refused",
            message: "The payment provider refused the charge.",
          },
        },
      },
    ]);
    const err = await client(fetchImpl)
      .subscriptions.update("sub_1", { target_price_id: "price_2" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentError);
    expect(err).toBeInstanceOf(APIError);
    // A sibling of InvalidRequestError, not a kind of it: the request was
    // fine, the money was not.
    expect(err).not.toBeInstanceOf(InvalidRequestError);
    expect((err as PaymentError).name).toBe("PaymentError");
    expect((err as PaymentError).code).toBe("payment_refused");
    expect((err as PaymentError).type).toBe("payment_error");
    expect(calls).toHaveLength(1);
  });

  it("402 tenant_suspended with no type -> PaymentError, type payment_error", async () => {
    const { fetchImpl } = makeMockFetch([
      { status: 402, body: { error: { code: "tenant_suspended", message: "suspended" } } },
    ]);
    const err = await client(fetchImpl)
      .customers.retrieve("cus_1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentError);
    expect((err as PaymentError).type).toBe("payment_error");
    expect((err as PaymentError).code).toBe("tenant_suspended");
  });

  it("5xx with no envelope -> ServerError, still a BillKitError", async () => {
    // Traefik / nginx HTML body; must not crash on JSON parse.
    const fetchImpl: typeof fetch = async () =>
      new Response("<html>bad gateway</html>", { status: 502 });
    try {
      await client(fetchImpl).customers.retrieve("cus_1");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError);
      expect(err).toBeInstanceOf(BillKitError);
      expect((err as ServerError).statusCode).toBe(502);
      // Not JSON, so the raw text is what a caller gets to look at.
      expect((err as ServerError).rawBody).toBe("<html>bad gateway</html>");
    }
  });
});

describe("the hierarchy", () => {
  it.each([
    [400, InvalidRequestError],
    [401, AuthenticationError],
    [402, PaymentError],
    [403, PermissionDeniedError],
    [404, NotFoundError],
    [409, ConflictError],
    [422, InvalidRequestError],
    [429, RateLimitError],
    [500, ServerError],
    [503, ServerError],
  ])("HTTP %i is an APIError carrying status, headers and the request id", async (status, cls) => {
    const { fetchImpl } = makeMockFetch([
      {
        status,
        body: { error: { type: "x", code: "c", message: "m", param: "p", reason: "r" } },
        headers: { "x-request-id": "req_123", "x-extra": "kept" },
      },
    ]);
    const err = await client(fetchImpl, { ...FAST_RETRY, maxAttempts: 1 })
      .customers.retrieve("cus_1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(cls);
    expect(err).toBeInstanceOf(APIError);
    expect(err).toBeInstanceOf(BillKitError);
    expect(err).not.toBeInstanceOf(APIConnectionError);
    const e = err as APIError;
    expect(e.name).toBe(cls.name);
    expect(e.statusCode).toBe(status);
    expect(e.requestId).toBe("req_123");
    expect(e.headers.get("x-extra")).toBe("kept");
    expect([e.type, e.code, e.param, e.reason, e.message]).toEqual(["x", "c", "p", "r", "m"]);
    expect(e.rawBody).toEqual({
      error: { type: "x", code: "c", message: "m", param: "p", reason: "r" },
    });
  });

  it("keeps an envelope value the SDK has never heard of, verbatim", async () => {
    const { fetchImpl } = makeMockFetch([
      {
        status: 400,
        body: {
          error: {
            type: "brand_new_error",
            code: "brand_new_code",
            reason: "brand_new_reason",
            message: "m",
            documentation_url: "https://example.test",
          },
        },
      },
    ]);
    const err = (await client(fetchImpl)
      .customers.retrieve("cus_1")
      .catch((e: unknown) => e)) as InvalidRequestError;
    expect(err).toBeInstanceOf(InvalidRequestError);
    expect([err.type, err.code, err.reason]).toEqual([
      "brand_new_error",
      "brand_new_code",
      "brand_new_reason",
    ]);
  });

  it("puts the timeout under the connection error and the webhook error under the root", () => {
    const timeout = new APITimeoutError("t");
    expect(timeout).toBeInstanceOf(APIConnectionError);
    expect(timeout).toBeInstanceOf(BillKitError);
    expect(timeout).not.toBeInstanceOf(APIError);
    expect(timeout.name).toBe("APITimeoutError");
    const webhook = new WebhookVerificationError("w");
    expect(webhook).toBeInstanceOf(BillKitError);
    expect(webhook).not.toBeInstanceOf(APIError);
    expect(webhook.name).toBe("WebhookVerificationError");
  });
});

describe("instanceof across copies of the package", () => {
  /**
   * What a NotFoundError thrown by the *other* build (CommonJS when this is
   * ESM) looks like from here: a different prototype chain entirely, with
   * only the Symbol.for brand in common. tests/dual-package.test.ts does the
   * same with two real builds.
   */
  function foreignError(kinds: string[], key = "@billkit-eu/sdk/error-kinds/v1"): Error {
    const err = new Error("from another copy");
    Object.defineProperty(err, Symbol.for(key), { value: kinds });
    return err;
  }

  it("does not match an error branded by another major version", () => {
    const kinds = ["NotFoundError", "APIError", "BillKitError"];
    for (const key of ["@billkit-eu/sdk/error-kinds/v2", "@billkit-eu/sdk/error-kinds"]) {
      const err = foreignError(kinds, key);
      expect(err instanceof NotFoundError).toBe(false);
      expect(err instanceof BillKitError).toBe(false);
    }
  });

  it("answers from the brand, not the prototype", () => {
    const err = foreignError(["NotFoundError", "APIError", "BillKitError"]);
    expect(err instanceof NotFoundError).toBe(true);
    expect(err instanceof APIError).toBe(true);
    expect(err instanceof BillKitError).toBe(true);
    expect(err instanceof ConflictError).toBe(false);
    expect(err instanceof APIConnectionError).toBe(false);
  });

  it("does not claim plain errors or non-objects", () => {
    expect(new Error("x") instanceof BillKitError).toBe(false);
    expect((null as unknown) instanceof BillKitError).toBe(false);
    expect(("NotFoundError" as unknown) instanceof NotFoundError).toBe(false);
  });

  it("keeps prototype semantics for a subclass without a brand of its own", () => {
    class MyNotFound extends NotFoundError {}
    const mine = new MyNotFound("m", { statusCode: 404 });
    const plain = new NotFoundError("p", { statusCode: 404 });
    expect(mine).toBeInstanceOf(NotFoundError);
    expect(mine).toBeInstanceOf(MyNotFound);
    expect(plain).not.toBeInstanceOf(MyNotFound);
  });
});
