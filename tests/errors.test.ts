import { describe, expect, it } from "vitest";

import { BillKit } from "../src/client.js";
import {
  AuthenticationError,
  BillKitError,
  ConflictError,
  InvalidRequestError,
  PermissionError,
  RateLimitError,
  ResourceMissingError,
  ServerError,
} from "../src/errors.js";
import type { RetryPolicy } from "../src/retry.js";
import { FAST_RETRY, makeMockFetch } from "./helpers.js";

function client(fetchImpl: typeof fetch, retryPolicy: RetryPolicy = FAST_RETRY) {
  return new BillKit({
    apiKey: "sk_test_unit",
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

  it("403 -> PermissionError", async () => {
    const { fetchImpl } = makeMockFetch([
      {
        status: 403,
        body: { error: { type: "permission_error", message: "no scope" } },
      },
    ]);
    await expect(client(fetchImpl).customers.retrieve("cus_1")).rejects.toBeInstanceOf(
      PermissionError,
    );
  });

  it("404 -> ResourceMissingError", async () => {
    const { fetchImpl } = makeMockFetch([
      {
        status: 404,
        body: { error: { type: "invalid_request_error", message: "no such" } },
      },
    ]);
    await expect(client(fetchImpl).customers.retrieve("cus_x")).rejects.toBeInstanceOf(
      ResourceMissingError,
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

  it("404 from an unmatched route (type api_error) -> ResourceMissingError", async () => {
    // The exact envelope Starlette's handler emits for a path no route
    // matches: `type: api_error` on a 404. Mapping on `type` made that a
    // ServerError, blaming BillKit for the caller's typo — and
    // ServerError is the class alerting and retry policies key on.
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
      expect(err).toBeInstanceOf(ResourceMissingError);
      expect(err).not.toBeInstanceOf(ServerError);
      // The envelope's own type is still preserved for callers who want it.
      expect((err as ResourceMissingError).type).toBe("api_error");
      expect((err as ResourceMissingError).code).toBe("unhandled");
    }
  });

  it("405 method-not-allowed (type api_error) -> InvalidRequestError", async () => {
    const { fetchImpl } = makeMockFetch([
      {
        status: 405,
        body: {
          error: { type: "api_error", code: "unhandled", message: "Method Not Allowed" },
        },
      },
    ]);
    const err = await client(fetchImpl)
      .customers.retrieve("cus_1")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidRequestError);
    expect(err).not.toBeInstanceOf(ServerError);
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
      expect((err as ServerError).rawBody).toBeUndefined();
    }
  });
});
