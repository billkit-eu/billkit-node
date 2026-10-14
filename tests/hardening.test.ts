/**
 * Transport and surface hardening from the pre-1.0 audit:
 *
 * - a blank caller `idempotencyKey` is treated as unset, so the POST the
 *   retry loop re-sends always carries one stable key; a number is sent
 *   as its decimal string, and a boolean or object is refused;
 * - JSON calls never follow a redirect (the PDF path still does);
 * - an empty id is refused locally instead of building `/v1/customers/`,
 *   as a rejected promise rather than a synchronous throw;
 * - test clocks are reachable, and `test_clock_id` rides on customer create;
 * - the event-type constants, and that an unknown type never throws.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BillKit } from "../src/client.js";
import { InvalidRequestError } from "../src/errors.js";
import { EVENT_TYPES, EventTypes, isKnownEventType } from "../src/eventTypes.js";
import { verifyWebhookSignature, type WebhookEvent } from "../src/webhooks.js";
import { FAST_RETRY, makeMockFetch } from "./helpers.js";

function client(fetchImpl: typeof fetch) {
  return new BillKit({
    apiKey: "bk_test_unit",
    baseUrl: "https://test.billkit.eu",
    retryPolicy: FAST_RETRY,
    fetch: fetchImpl,
  });
}

const BAD_GATEWAY = { status: 502, body: { error: { type: "api_error", message: "upstream" } } };

describe("a blank idempotencyKey is treated as unset", () => {
  for (const blank of ["", "   ", "\t\n"]) {
    it(`generates one key for ${JSON.stringify(blank)} and reuses it on every retry`, async () => {
      const { fetchImpl, calls } = makeMockFetch([
        BAD_GATEWAY,
        BAD_GATEWAY,
        { status: 200, body: { id: "cus_1" } },
      ]);
      await client(fetchImpl).customers.create({ email: "a@b.co" }, { idempotencyKey: blank });

      expect(calls).toHaveLength(3);
      const keys = calls.map((c) => c.headers["idempotency-key"]);
      expect(keys[0]).toMatch(/^sdk-[0-9a-f-]{36}$/);
      expect(new Set(keys)).toEqual(new Set([keys[0]]));
      // The blank value never reaches the body either.
      expect(JSON.parse(calls[0]!.body!)).toEqual({ email: "a@b.co" });
    });
  }

  for (const unset of [null, undefined]) {
    it(`generates a key for ${String(unset)}`, async () => {
      const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: {} }]);
      await client(fetchImpl).customers.create({}, { idempotencyKey: unset as unknown as string });
      expect(calls[0]!.headers["idempotency-key"]).toMatch(/^sdk-[0-9a-f-]{36}$/);
    });
  }

  // Plain-JS callers pass their numeric order id. 0.9.0 sent it as its
  // decimal string; the first blank check called `.trim()` on it and threw.
  for (const [value, expected] of [
    [12345, "12345"],
    [0, "0"],
    [12345678901234567890n, "12345678901234567890"],
  ] as const) {
    it(`sends the number ${String(value)} as "${expected}" on every retry`, async () => {
      const { fetchImpl, calls } = makeMockFetch([BAD_GATEWAY, { status: 200, body: {} }]);
      await client(fetchImpl).customers.create({}, { idempotencyKey: value as unknown as string });
      expect(calls.map((c) => c.headers["idempotency-key"])).toEqual([expected, expected]);
    });
  }

  for (const bad of [true, false, { id: 1 }, Number.NaN]) {
    it(`refuses ${String(bad)} without sending anything`, async () => {
      const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: {} }]);
      await expect(
        client(fetchImpl).customers.create({}, { idempotencyKey: bad as unknown as string }),
      ).rejects.toThrow(TypeError);
      expect(calls).toHaveLength(0);
    });
  }

  it("still sends a real caller key verbatim", async () => {
    const { fetchImpl, calls } = makeMockFetch([BAD_GATEWAY, { status: 200, body: {} }]);
    await client(fetchImpl).customers.create({}, { idempotencyKey: "order-42" });
    expect(calls.map((c) => c.headers["idempotency-key"])).toEqual(["order-42", "order-42"]);
  });
});

/**
 * A real HTTP server and the runtime's real `fetch`, because the bug is
 * in what `fetch` does with a 307 by default; a mock would only prove
 * what the mock does.
 */
describe("redirects", () => {
  let server: Server;
  let baseUrl: string;
  const hits: { path: string; method: string; body: string; idem: string | undefined }[] = [];

  async function readAll(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      void readAll(req).then((body) => {
        const path = req.url ?? "";
        const idem = req.headers["idempotency-key"];
        hits.push({
          path,
          method: req.method ?? "",
          body,
          idem: Array.isArray(idem) ? idem[0] : idem,
        });
        if (path.startsWith("/v1/") && !path.startsWith("/v1/invoices/in_1/pdf")) {
          res.writeHead(307, { Location: "/elsewhere" });
          res.end();
        } else if (path === "/v1/invoices/in_1/pdf") {
          res.writeHead(302, { Location: "/signed/in_1.pdf" });
          res.end();
        } else if (path === "/signed/in_1.pdf") {
          res.writeHead(200, { "content-type": "application/pdf" });
          res.end("%PDF-1.7");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "cus_from_the_redirect_target" }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("refuses a 307 on a JSON call instead of re-sending the body to the target", async () => {
    hits.length = 0;
    const c = new BillKit({ apiKey: "bk_test_unit", baseUrl, retryPolicy: FAST_RETRY });

    const err = await c.customers
      .create({ email: "ada@example.com" })
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(InvalidRequestError);
    expect((err as InvalidRequestError).statusCode).toBe(307);
    expect((err as Error).message).toMatch(/redirect/);
    // One request, to the route itself; nothing went to the target.
    expect(hits.map((h) => h.path)).toEqual(["/v1/customers"]);
  });

  it("still follows the storage adapter's redirect on the PDF path", async () => {
    hits.length = 0;
    const c = new BillKit({ apiKey: "bk_test_unit", baseUrl, retryPolicy: FAST_RETRY });
    const pdf = await c.invoices.retrievePdf("in_1");
    expect(new TextDecoder().decode(pdf)).toBe("%PDF-1.7");
    expect(hits.map((h) => h.path)).toEqual(["/v1/invoices/in_1/pdf", "/signed/in_1.pdf"]);
  });

  it("treats a browser-style opaque redirect as an error too", async () => {
    const opaque: typeof fetch = () =>
      Promise.resolve(
        // What a browser hands back for `redirect: "manual"`: status 0,
        // not ok, no headers. `new Response` cannot build status 0.
        Object.defineProperties(new Response(null, { status: 200 }), {
          type: { value: "opaqueredirect" },
          status: { value: 0 },
          ok: { value: false },
        }),
      );
    await expect(client(opaque).customers.retrieve("cus_1")).rejects.toBeInstanceOf(
      InvalidRequestError,
    );
  });
});

describe("empty ids are refused before a request is built", () => {
  const cases: [string, (c: BillKit) => Promise<unknown>][] = [
    ["customers.retrieve", (c) => c.customers.retrieve("")],
    ["customers.update", (c) => c.customers.update("  ", { name: "x" })],
    ["customers.delete", (c) => c.customers.delete("")],
    ["subscriptions.cancel", (c) => c.subscriptions.cancel("")],
    ["invoices.retrievePdf", (c) => c.invoices.retrievePdf("")],
    ["testClocks.advance", (c) => c.testClocks.advance("", { frozen_time: 1 })],
    [
      "webhookEndpoints.retrieveDelivery",
      (c) => c.webhookEndpoints.retrieveDelivery("we_1", ""),
    ],
  ];
  for (const [name, call] of cases) {
    it(name, async () => {
      const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: {} }]);
      // Called bare, not inside an async wrapper that would turn a
      // synchronous throw into a rejection and hide it: the method itself
      // has to hand back a promise that `.catch()` sees.
      let caught: unknown;
      await call(client(fetchImpl)).catch((err: unknown) => {
        caught = err;
      });
      expect(caught).toBeInstanceOf(TypeError);
      expect(String(caught)).toMatch(/an id is required/);
      expect(calls).toHaveLength(0);
    });
  }

  it.each([".", ".."])("refuses the dot segment %j as an id", async (id) => {
    // Percent-encoding leaves `.` and `..` alone, and the URL parser would
    // resolve them: `retrieve("..")` must not become `GET /v1/`.
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: {} }]);
    const caught = await client(fetchImpl)
      .customers.retrieve(id)
      .catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(TypeError);
    expect(String(caught)).toMatch(/is not an id/);
    const delivery = await client(fetchImpl)
      .webhookEndpoints.retrieveDelivery("we_1", id)
      .catch((err: unknown) => err);
    expect(delivery).toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("no resource method throws synchronously on an empty id", () => {
    // Every method on every resource, called with empty ids. Any of them
    // may reject (or return an iterator that fails on first use); none
    // may throw out of the call itself.
    const { fetchImpl } = makeMockFetch([]);
    const c = client(fetchImpl) as unknown as Record<string, unknown>;
    const syncThrows: string[] = [];
    let checked = 0;
    for (const [accessor, resource] of Object.entries(c)) {
      if (typeof resource !== "object" || resource === null) continue;
      const proto = Object.getPrototypeOf(resource) as object;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const fn = (resource as Record<string, unknown>)[name];
        if (name === "constructor" || typeof fn !== "function") continue;
        checked += 1;
        try {
          const out = (fn as (...a: unknown[]) => unknown).call(resource, "", "", {});
          // Swallow the rejection so vitest does not report it as unhandled.
          if (out instanceof Promise) out.catch(() => undefined);
        } catch {
          syncThrows.push(`${accessor}.${name}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(syncThrows).toEqual([]);
  });

  it("a decimal rate passed as a number rejects rather than throwing", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: {} }]);
    let caught: unknown;
    await client(fetchImpl)
      .prices.create({
        product_id: "prod_1",
        currency: "EUR",
        interval: "month",
        usage_type: "metered",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        unit_amount_decimal: 0.0002 as any,
      })
      .catch((err: unknown) => {
        caught = err;
      });
    expect(caught).toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe("TestClocks", () => {
  it("create POSTs the body with an idempotency key", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: { id: "clock_1" } }]);
    await client(fetchImpl).testClocks.create({ frozen_time: 1_800_000_000, name: "Renewals" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://test.billkit.eu/v1/test_clocks");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ frozen_time: 1_800_000_000, name: "Renewals" });
    expect(calls[0]?.headers["idempotency-key"]).toMatch(/^sdk-/);
  });

  it("retrieve, advance, delete, list hit the right routes", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: {} },
      { status: 200, body: {} },
      { status: 200, body: { id: "clock_1", object: "test_clock", deleted: true } },
      { status: 200, body: { object: "list", data: [], has_more: false } },
    ]);
    const c = client(fetchImpl);
    await c.testClocks.retrieve("clock_1");
    await c.testClocks.advance("clock_1", { frozen_time: 1_900_000_000 }, { idempotencyKey: "adv-1" });
    await c.testClocks.delete("clock_1");
    await c.testClocks.list({ limit: 5 });

    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      "GET https://test.billkit.eu/v1/test_clocks/clock_1",
      "POST https://test.billkit.eu/v1/test_clocks/clock_1/advance",
      "DELETE https://test.billkit.eu/v1/test_clocks/clock_1",
      "GET https://test.billkit.eu/v1/test_clocks?limit=5",
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ frozen_time: 1_900_000_000 });
    expect(calls[1]?.headers["idempotency-key"]).toBe("adv-1");
  });

  it("iter walks every page", async () => {
    const { fetchImpl, calls } = makeMockFetch([
      { status: 200, body: { object: "list", data: [{ id: "clock_2" }], has_more: true } },
      { status: 200, body: { object: "list", data: [{ id: "clock_1" }], has_more: false } },
    ]);
    const ids: string[] = [];
    for await (const clock of client(fetchImpl).testClocks.iter<{ id: string }>()) {
      ids.push(clock.id);
    }
    expect(ids).toEqual(["clock_2", "clock_1"]);
    expect(calls[1]?.url).toContain("starting_after=clock_2");
  });

  it("customers.create carries test_clock_id", async () => {
    const { fetchImpl, calls } = makeMockFetch([{ status: 200, body: {} }]);
    await client(fetchImpl).customers.create({ email: "a@b.co", test_clock_id: "clock_1" });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ email: "a@b.co", test_clock_id: "clock_1" });
  });
});

describe("event types", () => {
  it("exports the catalogue as constants and a list", () => {
    expect(EventTypes.INVOICE_PAID).toBe("invoice.paid");
    expect(EVENT_TYPES).toContain("subscription.updated");
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
    expect(isKnownEventType("invoice.paid")).toBe(true);
    expect(isKnownEventType("invoice.something_new")).toBe(false);
  });

  it("verifies a delivery whose type this SDK does not know, and keeps previous_attributes", async () => {
    const secret = "bkwhsec_unit";
    const body = JSON.stringify({
      id: "evt_1",
      object: "event",
      type: "subscription.something_added_later",
      created: 1,
      livemode: false,
      data: { id: "sub_1", status: "active" },
      previous_attributes: { status: "trialing" },
    });
    const ts = Math.floor(Date.now() / 1000);
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${body}`)));
    const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");

    const event = await verifyWebhookSignature<WebhookEvent>({
      payload: body,
      signatureHeader: `t=${ts},v1=${hex}`,
      secret,
    });
    expect(isKnownEventType(event.type)).toBe(false);
    expect(event.previous_attributes).toEqual({ status: "trialing" });
    expect(event.data).toEqual({ id: "sub_1", status: "active" });
  });
});
