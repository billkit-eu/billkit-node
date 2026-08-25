import { describe, expect, it } from "vitest";

import { WebhookVerificationError, verifyWebhookSignature } from "../src/webhooks.js";

const SECRET = "whsec_unit_test_secret";
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
        secret: "whsec_wrong",
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
    const bad = await sign(BODY, "whsec_rotated_out", ts);
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
    const bad1 = (await sign(BODY, "whsec_wrong_a", ts)).split("v1=")[1];
    const bad2 = (await sign(BODY, "whsec_wrong_b", ts)).split("v1=")[1];
    await expect(
      verifyWebhookSignature({
        payload: BODY,
        signatureHeader: `t=${ts},v1=${bad1},v1=${bad2}`,
        secret: SECRET,
      }),
    ).rejects.toThrow(/mismatch/);
  });
});
