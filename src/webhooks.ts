/**
 * Verify `BillKit-Signature: t=<unix>,v1=<hex>` headers.
 *
 * Works in Node 20+, Bun, Deno, Cloudflare Workers and the browser:
 * we use the Web Crypto API (`globalThis.crypto.subtle`) which is
 * available in all modern runtimes. The verifier:
 *
 * 1. Parses the header (rejects malformed shapes). A header may carry
 *    more than one `v1=` value, because the server emits both the old and new
 *    signature during a signing-secret rotation, and verification passes
 *    if any of them matches.
 * 2. Confirms the timestamp is within `toleranceSeconds` of now
 *    (replay protection).
 * 3. Computes the expected HMAC and compares against each candidate in
 *    constant time.
 */

export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export class WebhookVerificationError extends Error {
  override name = "WebhookVerificationError";
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface VerifyWebhookOptions {
  payload: string | Uint8Array;
  signatureHeader: string | null | undefined;
  secret: string;
  toleranceSeconds?: number;
  nowMs?: number; // injectable for tests
}

const textEncoder = new TextEncoder();
const V1_HEX_RE = /^[0-9a-fA-F]{64}$/;

function toBytes(payload: string | Uint8Array): Uint8Array {
  return typeof payload === "string" ? textEncoder.encode(payload) : payload;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!V1_HEX_RE.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

function parseSignatureHeader(header: string): { ts: number; v1List: string[] } {
  let tsRaw: string | undefined;
  const v1List: string[] = [];
  for (const chunk of header.split(",")) {
    const idx = chunk.indexOf("=");
    if (idx < 0) continue;
    const key = chunk.slice(0, idx).trim();
    const value = chunk.slice(idx + 1).trim();
    // A rotation can carry more than one ``v1=`` (old + new secret);
    // collect them all and let the verifier accept any match.
    if (key === "t") tsRaw = value;
    else if (key === "v1") v1List.push(value);
  }
  if (!tsRaw || v1List.length === 0) {
    throw new WebhookVerificationError(`Malformed BillKit-Signature header: ${header}`);
  }
  const ts = Number.parseInt(tsRaw, 10);
  if (Number.isNaN(ts) || ts <= 0) {
    throw new WebhookVerificationError(`Malformed timestamp in BillKit-Signature: ${tsRaw}`);
  }
  return { ts, v1List };
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  // ``Uint8Array.buffer`` is ``ArrayBufferLike`` (could be
  // ``SharedArrayBuffer``); SubtleCrypto wants a concrete
  // ``ArrayBuffer``. We copy into a fresh ArrayBuffer to bridge.
  const out = new ArrayBuffer(view.byteLength);
  new Uint8Array(out).set(view);
  return out;
}

async function computeHmac(secret: string, signed: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new WebhookVerificationError(
      "No SubtleCrypto available. The BillKit SDK requires Node 20+, Bun, Deno, " +
        "Cloudflare Workers, or any runtime that exposes globalThis.crypto.subtle.",
    );
  }
  const key = await subtle.importKey(
    "raw",
    toArrayBuffer(textEncoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await subtle.sign("HMAC", key, toArrayBuffer(signed));
  return new Uint8Array(signature);
}

export async function verifyWebhookSignature<T = unknown>(
  options: VerifyWebhookOptions,
): Promise<T> {
  const {
    payload,
    signatureHeader,
    secret,
    toleranceSeconds = DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
    nowMs = Date.now(),
  } = options;

  if (signatureHeader === null || signatureHeader === undefined) {
    throw new WebhookVerificationError("Missing BillKit-Signature header.");
  }

  const { ts, v1List } = parseSignatureHeader(signatureHeader);
  if (Math.abs(nowMs / 1000 - ts) > toleranceSeconds) {
    throw new WebhookVerificationError(
      `Signature timestamp outside ±${toleranceSeconds}s tolerance.`,
    );
  }

  const payloadBytes = toBytes(payload);
  const signed = new Uint8Array(payloadBytes.length + textEncoder.encode(`${ts}.`).length);
  const prefix = textEncoder.encode(`${ts}.`);
  signed.set(prefix, 0);
  signed.set(payloadBytes, prefix.length);

  const expected = await computeHmac(secret, signed);
  // Compare against every candidate; don't break on the first match so
  // the loop's timing doesn't reveal which signature matched.
  let sawValidHex = false;
  let matched = false;
  for (const v1 of v1List) {
    const received = hexToBytes(v1);
    if (!received) continue;
    sawValidHex = true;
    if (constantTimeEqual(expected, received)) matched = true;
  }
  if (!sawValidHex) {
    throw new WebhookVerificationError(
      `Malformed v1 hex in BillKit-Signature: ${v1List.join(",")}`,
    );
  }
  if (!matched) {
    throw new WebhookVerificationError("Signature mismatch.");
  }

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const text = decoder.decode(payloadBytes);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new WebhookVerificationError(
      `Webhook body is not valid JSON: ${(err as Error).message}`,
    );
  }
}
