/**
 * The SDK's logging must be opt-in and leak-free.
 *
 * Two properties are load-bearing and easy to regress:
 *
 * 1. **Silent by default.** A library that reaches for `console` on its
 *    own takes over its host application's output. The SDK must emit
 *    nothing until a logger is handed to it.
 * 2. **No secrets, ever.** API keys, request/response bodies and query
 *    strings must never reach a log call. The caller's log sink is not
 *    somewhere a payments SDK gets to put customer PII.
 */

import { describe, expect, it, vi } from "vitest";

import { BillKit } from "../src/client.js";
import { ServerError } from "../src/errors.js";
import { NOOP_LOGGER, type BillKitLogger, type LogContext } from "../src/logging.js";
import { FAST_RETRY, makeMockFetch } from "./helpers.js";

interface Recorded {
  level: "debug" | "warn";
  message: string;
  context: LogContext | undefined;
}

function recordingLogger(): { logger: BillKitLogger; lines: Recorded[] } {
  const lines: Recorded[] = [];
  return {
    lines,
    logger: {
      debug: (message, context) => void lines.push({ level: "debug", message, context }),
      warn: (message, context) => void lines.push({ level: "warn", message, context }),
    },
  };
}

/** Everything the SDK handed the logger, flattened for leak scanning. */
function blob(lines: Recorded[]): string {
  return lines.map((l) => `${l.message} ${JSON.stringify(l.context ?? {})}`).join("\n");
}

describe("logging", () => {
  it("is silent by default: no logger, no console", async () => {
    const spies = {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      debug: vi.spyOn(console, "debug").mockImplementation(() => {}),
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
    const { fetchImpl } = makeMockFetch([{ status: 200, body: { id: "cus_1" } }]);
    const client = new BillKit({
      apiKey: "sk_test_unit",
      baseUrl: "https://test.billkit.eu",
      fetch: fetchImpl,
    });

    await client.customers.create({ email: "a@b.co" });

    for (const [name, spy] of Object.entries(spies)) {
      expect(spy, `SDK wrote to console.${name} without being asked`).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it("NOOP_LOGGER swallows everything", () => {
    expect(() => {
      NOOP_LOGGER.debug("x", { a: 1 });
      NOOP_LOGGER.warn("y");
    }).not.toThrow();
  });

  it("console satisfies BillKitLogger with no adapter", () => {
    // Compile-time claim made explicit: if this assignment ever stops
    // type-checking, the README's `logger: console` example is a lie.
    const logger: BillKitLogger = console;
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.warn).toBe("function");
  });

  it("logs request and response at debug when a logger is supplied", async () => {
    const { logger, lines } = recordingLogger();
    const { fetchImpl } = makeMockFetch([
      { status: 200, body: { id: "cus_1" }, headers: { "x-request-id": "req_abc" } },
    ]);
    const client = new BillKit({
      apiKey: "sk_test_unit",
      baseUrl: "https://test.billkit.eu",
      fetch: fetchImpl,
      logger,
    });

    await client.customers.create({ email: "a@b.co" });

    const request = lines.find((l) => l.message === "BillKit request");
    const response = lines.find((l) => l.message === "BillKit response");
    expect(request?.level).toBe("debug");
    expect(request?.context).toMatchObject({
      method: "POST",
      url: "https://test.billkit.eu/v1/customers",
      attempt: 1,
    });
    expect(response?.level).toBe("debug");
    expect(response?.context).toMatchObject({ status: 200, requestId: "req_abc" });
    expect(typeof response?.context?.["durationMs"]).toBe("number");
  });

  it("logs one warn per retry, with the reason and delay", async () => {
    const { logger, lines } = recordingLogger();
    const { fetchImpl } = makeMockFetch([
      { status: 503, body: { error: { type: "api_error", message: "down" } } },
      { status: 200, body: { id: "cus_1" } },
    ]);
    const client = new BillKit({
      apiKey: "sk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
      logger,
    });

    await client.customers.create({ email: "a@b.co" });

    const retries = lines.filter((l) => l.level === "warn");
    expect(retries).toHaveLength(1);
    expect(retries[0]?.message).toBe("BillKit retrying");
    expect(retries[0]?.context).toMatchObject({ reason: "HTTP 503", attempt: 1, delayMs: 0 });
  });

  it("names the failure reason when a retry follows a network error", async () => {
    const { logger, lines } = recordingLogger();
    const err = new Error("socket hang up");
    err.name = "FetchError";
    const { fetchImpl } = makeMockFetch([{ status: 0, error: err }, { status: 200, body: {} }]);
    const client = new BillKit({
      apiKey: "sk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
      logger,
    });

    await client.customers.create({ email: "a@b.co" });

    const retry = lines.find((l) => l.level === "warn");
    expect(retry?.context).toMatchObject({ reason: "FetchError" });
  });

  it("raises the final failure instead of logging it", async () => {
    const { logger, lines } = recordingLogger();
    const { fetchImpl } = makeMockFetch([
      { status: 500, body: { error: { type: "api_error", message: "boom" } } },
      { status: 500, body: { error: { type: "api_error", message: "boom" } } },
      { status: 500, body: { error: { type: "api_error", message: "boom" } } },
    ]);
    const client = new BillKit({
      apiKey: "sk_test_unit",
      baseUrl: "https://test.billkit.eu",
      retryPolicy: FAST_RETRY,
      fetch: fetchImpl,
      logger,
    });

    // The thrown error carries status, requestId and retryAfter. Logging
    // it here too would hand the caller a duplicate they can't suppress.
    await expect(client.customers.create({ email: "a@b.co" })).rejects.toThrow(ServerError);
    expect(lines.some((l) => l.message.toLowerCase().includes("error"))).toBe(false);
  });

  it("never logs the api key, bodies, or the query string", async () => {
    const { logger, lines } = recordingLogger();
    const { fetchImpl } = makeMockFetch([
      { status: 200, body: { id: "cus_1", email: "ada@example.com", name: "Ada Lovelace" } },
      { status: 200, body: { object: "list", data: [], has_more: false } },
    ]);
    const client = new BillKit({
      apiKey: "sk_test_unit",
      baseUrl: "https://test.billkit.eu",
      fetch: fetchImpl,
      logger,
    });

    await client.customers.create({ email: "ada@example.com", name: "Ada Lovelace" });
    await client.auditLogs.list({ actor_id: "act_secret_filter" });

    const text = blob(lines);
    expect(text.length, "expected log lines; the rest would pass vacuously").toBeGreaterThan(0);
    expect(text, "the API key reached a log call").not.toContain("sk_test_unit");
    expect(text, "the Authorization header reached a log call").not.toContain("Bearer");
    expect(text, "a body (PII) reached a log call").not.toContain("ada@example.com");
    expect(text, "a body (PII) reached a log call").not.toContain("Ada Lovelace");
    expect(text, "a query-string value reached a log call").not.toContain("act_secret_filter");
    expect(text, "a query string was appended to the logged url").not.toContain("?");
  });
});
