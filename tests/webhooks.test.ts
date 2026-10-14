import { describe, expect, it } from "vitest";

import { BillKitError } from "../src/errors.js";
import type { WebhookEvent } from "../src/generated/models.js";
import {
  WebhookVerificationError,
  verifyWebhookSignature,
  verifyWebhookSignatureAt,
} from "../src/webhooks.js";

const SECRET = "bkwhsec_unit_test_secret";
const BODY = '{"id":"evt_1","type":"customer.created","data":{"id":"cus_1"}}';

async function sign(body: string, secret: string, tsSeconds: number): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = new TextEncoder().encode(`${tsSeconds}.${body}`);
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, signed);
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${tsSeconds},v1=${hex}`;
}

describe("webhook verification", () => {
  it("accepts a valid signature and returns the decoded event", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = await sign(BODY, SECRET, ts);

    const event = await verifyWebhookSignature<{ id: string; type: string }>({
      payload: BODY,
      signatureHeader: header,
      secret: SECRET,
    });
    expect(event.id).toBe("evt_1");
    expect(event.type).toBe("customer.created");
  });

  it("accepts a Uint8Array payload", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = await sign(BODY, SECRET, ts);

    const bytes = new TextEncoder().encode(BODY);
    const event = await verifyWebhookSignature<{ id: string }>({
      payload: bytes,
      signatureHeader: header,
      secret: SECRET,
    });
    expect(event.id).toBe("evt_1");
  });

  it("rejects a stale timestamp (replay)", async () => {
    const ts = Math.floor(Date.now() / 1000) - 600;
    const header = await sign(BODY, SECRET, ts);
    await expect(
      verifyWebhookSignature({
        payload: BODY,
        signatureHeader: header,
        secret: SECRET,
      }),
    ).rejects.toThrow(/tolerance/);
  });

  it("rejects tampered body", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = await sign(BODY, SECRET, ts);
    const tampered = BODY.replace("cus_1", "cus_9");
    await expect(
      verifyWebhookSignature({
        payload: tampered,
        signatureHeader: header,
        secret: SECRET,
      }),
    ).rejects.toThrow(/mismatch/);
  });

  it("rejects wrong secret", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = await sign(BODY, SECRET, ts);
    await expect(
      verifyWebhookSignature({
        payload: BODY,
        signatureHeader: header,
        secret: "bkwhsec_wrong",
      }),
    ).rejects.toThrow(/mismatch/);
  });

  it("rejects missing header", async () => {
    await expect(
      verifyWebhookSignature({
        payload: BODY,
        signatureHeader: null,
        secret: SECRET,
      }),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("rejects malformed header", async () => {
    await expect(
      verifyWebhookSignature({
        payload: BODY,
        signatureHeader: "not-a-real-header",
        secret: SECRET,
      }),
    ).rejects.toThrow(/Malformed/);
  });

  it("rejects malformed v1 hex", async () => {
    const ts = Math.floor(Date.now() / 1000);
    await expect(
      verifyWebhookSignature({
        payload: BODY,
        signatureHeader: `t=${ts},v1=${"z".repeat(64)}`,
        secret: SECRET,
      }),
    ).rejects.toThrow(/Malformed/);
  });

  it("rejects non-JSON body after signature passes", async () => {
    const body = "<html>not json</html>";
    const ts = Math.floor(Date.now() / 1000);
    const header = await sign(body, SECRET, ts);
    await expect(
      verifyWebhookSignature({
        payload: body,
        signatureHeader: header,
        secret: SECRET,
      }),
    ).rejects.toThrow(/JSON/);
  });

  it("accepts when any of multiple v1 values matches (rotation)", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const good = await sign(BODY, SECRET, ts); // "t=...,v1=<good>"
    const bad = await sign(BODY, "bkwhsec_rotated_out", ts);
    const badHex = bad.split("v1=")[1];
    const header = `${good},v1=${badHex}`; // t=...,v1=<good>,v1=<bad>

    const event = await verifyWebhookSignature<{ id: string }>({
      payload: BODY,
      signatureHeader: header,
      secret: SECRET,
    });
    expect(event.id).toBe("evt_1");
  });

  it("rejects when none of multiple v1 values match", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const bad1 = (await sign(BODY, "bkwhsec_wrong_a", ts)).split("v1=")[1];
    const bad2 = (await sign(BODY, "bkwhsec_wrong_b", ts)).split("v1=")[1];
    await expect(
      verifyWebhookSignature({
        payload: BODY,
        signatureHeader: `t=${ts},v1=${bad1},v1=${bad2}`,
        secret: SECRET,
      }),
    ).rejects.toThrow(/mismatch/);
  });
});

describe("the verified event", () => {
  it("is typed as the WebhookEvent union by default and narrows on type", async () => {
    const body = JSON.stringify({
      id: "evt_2",
      object: "event",
      type: "invoice.paid",
      created: 1,
      livemode: false,
      data: { id: "inv_1", object: "invoice", number: "INV-0001" },
      previous_attributes: null,
    });
    const header = await sign(body, SECRET, Math.floor(Date.now() / 1000));
    const event: WebhookEvent = await verifyWebhookSignature({
      payload: body,
      signatureHeader: header,
      secret: SECRET,
    });
    if (event.type !== "invoice.paid") throw new Error("narrowing failed");
    expect(event.data.number).toBe("INV-0001");
    expect(event.previous_attributes).toBeNull();
  });

  it("passes an unknown event type and unknown fields through untouched", async () => {
    // A newer API can deliver a type this SDK has never heard of, and add
    // fields to one it has. Neither may throw: the handler acknowledges it.
    const body = JSON.stringify({
      id: "evt_3",
      object: "event",
      type: "teleporter.calibrated",
      created: 1,
      livemode: false,
      data: { id: "tp_1", brand_new_field: { nested: [1, 2] } },
      previous_attributes: { warp: 1 },
      delivered_from: "the future",
    });
    const header = await sign(body, SECRET, Math.floor(Date.now() / 1000));
    const event = await verifyWebhookSignature<Record<string, unknown>>({
      payload: body,
      signatureHeader: header,
      secret: SECRET,
    });
    expect(event).toEqual(JSON.parse(body));
  });

  it("a verification failure is a BillKitError", async () => {
    const err = await verifyWebhookSignature({
      payload: BODY,
      signatureHeader: undefined,
      secret: SECRET,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebhookVerificationError);
    expect(err).toBeInstanceOf(BillKitError);
  });
});

describe("the replay window", () => {
  const ts = 1_800_000_000;

  it("accepts a delivery exactly at the edge of the tolerance", async () => {
    const header = await sign(BODY, SECRET, ts);
    await expect(
      verifyWebhookSignatureAt(
        { payload: BODY, signatureHeader: header, secret: SECRET },
        (ts + 300) * 1000,
      ),
    ).resolves.toMatchObject({ id: "evt_1" });
  });

  it("refuses one a second past it, in either direction", async () => {
    const header = await sign(BODY, SECRET, ts);
    for (const now of [(ts + 301) * 1000, (ts - 301) * 1000]) {
      await expect(
        verifyWebhookSignatureAt({ payload: BODY, signatureHeader: header, secret: SECRET }, now),
      ).rejects.toThrow(/tolerance/);
    }
  });

  it("no longer takes a clock from the public options", async () => {
    // nowMs was a public option in 0.x; a caller could pass any clock and
    // switch off the replay guard. The public function reads the real one.
    const header = await sign(BODY, SECRET, ts);
    await expect(
      verifyWebhookSignature({
        payload: BODY,
        signatureHeader: header,
        secret: SECRET,
        nowMs: ts * 1000,
      } as never),
    ).rejects.toThrow(/tolerance/);
  });
});

describe("inputs that can never verify", () => {
  const ts = 1_800_000_000;
  const at = (options: Parameters<typeof verifyWebhookSignatureAt>[0]) =>
    verifyWebhookSignatureAt(options, ts * 1000);

  it.each([
    ["a parsed body", JSON.parse(BODY) as unknown],
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
  ])("refuses %s as the payload with a WebhookVerificationError", async (_label, payload) => {
    const header = await sign(BODY, SECRET, ts);
    const err = await at({
      payload: payload as string,
      signatureHeader: header,
      secret: SECRET,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebhookVerificationError);
    expect((err as Error).message).toBe(
      "payload must be the raw request body (string or Uint8Array), not a parsed object",
    );
  });

  it.each(["", " ", "\t\n"])("refuses the secret %j before verifying", async (secret) => {
    // Signed with that same blank key: without the guard, a whitespace
    // secret verifies a signature anyone could have computed.
    const header = secret === "" ? await sign(BODY, SECRET, ts) : await sign(BODY, secret, ts);
    const err = await at({ payload: BODY, signatureHeader: header, secret }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WebhookVerificationError);
    expect((err as Error).message).toMatch(/signing secret is empty/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "refuses the tolerance %s as a RangeError",
    async (toleranceSeconds) => {
      // An hour-old signature: NaN compares false against everything, so
      // without the guard it would be accepted as fresh.
      const header = await sign(BODY, SECRET, ts - 3600);
      const err = await at({ payload: BODY, signatureHeader: header, secret: SECRET, toleranceSeconds }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RangeError);
      expect((err as Error).message).toMatch(/toleranceSeconds/);
    },
  );

  it("refuses an undefined secret (an unset env var read with `!`)", async () => {
    const header = await sign(BODY, SECRET, ts);
    const err = await at({
      payload: BODY,
      signatureHeader: header,
      secret: undefined as unknown as string,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebhookVerificationError);
    expect((err as Error).message).toMatch(/signing secret is empty/);
  });

  it.each(["1e9", "123abc", "-5", "+1800000000", " ", "0x6B49D200", "1".repeat(13), "9".repeat(40)])(
    "refuses the timestamp %j as malformed",
    async (tsRaw) => {
      const v1 = (await sign(BODY, SECRET, ts)).split(",")[1];
      const err = await at({
        payload: BODY,
        signatureHeader: `t=${tsRaw},${v1}`,
        secret: SECRET,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WebhookVerificationError);
      expect((err as Error).message).toMatch(/Malformed (timestamp|BillKit-Signature)/);
    },
  );
});
