/**
 * Verify `BillKit-Signature: t=<unix>,v1=<hex>` headers.
 *
 * Uses the Web Crypto API (`globalThis.crypto.subtle`), so it has no
 * Node-specific dependency. Node 22 and 24 are what is tested. The verifier:
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

import { WebhookVerificationError } from "./errors.js";
import type { UnknownWebhookEvent, WebhookEvent } from "./generated/models.js";

export { WebhookVerificationError };
export type { UnknownWebhookEvent, WebhookEvent };

export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export interface VerifyWebhookOptions {
  /** The raw request body, exactly as received: bytes or the undecoded string. */
  payload: string | Uint8Array;
  /** The `BillKit-Signature` header. */
  signatureHeader: string | null | undefined;
  /** The endpoint's signing secret (`bkwhsec_...`). */
  secret: string;
  /** Replay window in seconds, a finite number 0 or more (otherwise a `RangeError`). Default 300. */
  toleranceSeconds?: number;
}

const textEncoder = new TextEncoder();
const V1_HEX_RE = /^[0-9a-fA-F]{64}$/;
const TIMESTAMP_RE = /^[0-9]{1,12}$/;

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
  // Digits only, and no more of them than a Unix time in seconds has for the
  // next thirty thousand years. `parseInt` alone read "1e9" as 1 and
  // "123abc" as 123, and a huge value lost precision on the way to a number.
  if (!TIMESTAMP_RE.test(tsRaw)) {
    throw new WebhookVerificationError(`Malformed timestamp in BillKit-Signature: ${tsRaw}`);
  }
  const ts = Number.parseInt(tsRaw, 10);
  if (ts <= 0) {
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
      "No SubtleCrypto available. The BillKit SDK requires Node 22+ " +
        "(or a runtime that exposes globalThis.crypto.subtle).",
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

/**
 * Verify a delivery's signature and return its parsed body.
 *
 * Resolves to `WebhookEvent | UnknownWebhookEvent`. A newer API can deliver
 * an event type this SDK version does not know, so narrow with
 * {@link isKnownEventType} before switching on `type`:
 *
 * ```ts
 * const event = await verifyWebhookSignature({ payload, signatureHeader, secret });
 * if (!isKnownEventType(event)) return; // newer than this SDK: acknowledge it
 * switch (event.type) {
 *   case "invoice.paid":
 *     await markPaid(event.data.id); // event.data is an Invoice
 *     break;
 * }
 * ```
 *
 * New event types are additive in 1.x, so an exhaustive `never` check over
 * `event.type` is not supported: the next minor release that names a new
 * type would stop it compiling.
 *
 * The type parameter is an unchecked assertion for callers who want their
 * own event type. Nothing here rejects an event `type` the SDK does not
 * know, and unknown fields pass through untouched.
 */
export async function verifyWebhookSignature<T = WebhookEvent | UnknownWebhookEvent>(
  options: VerifyWebhookOptions,
): Promise<T> {
  return verifyWebhookSignatureAt<T>(options, Date.now());
}

/**
 * {@link verifyWebhookSignature} against a fixed clock. Internal: the test
 * seam for the replay window, deliberately not exported from the package.
 */
export async function verifyWebhookSignatureAt<T>(
  options: VerifyWebhookOptions,
  nowMs: number,
): Promise<T> {
  const {
    payload,
    signatureHeader,
    secret,
    toleranceSeconds = DEFAULT_WEBHOOK_TOLERANCE_SECONDS,
  } = options;
  // Before anything else: an empty secret (an unset environment variable,
  // typically) is a key anyone can sign with, so it must never reach the HMAC.
  if (typeof secret !== "string" || secret.trim() === "") {
    throw new WebhookVerificationError(
      "The webhook signing secret is empty. Pass the endpoint's signing secret " +
        "(bkwhsec_...); check that the environment variable holding it is set.",
    );
  }
  // A framework body parser hands over an object, which has already lost the
  // exact bytes that were signed. Say so instead of failing inside the encoder.
  if (typeof payload !== "string" && !(payload instanceof Uint8Array)) {
    throw new WebhookVerificationError(
      "payload must be the raw request body (string or Uint8Array), not a parsed object",
    );
  }
  // A tolerance that is not a finite number of seconds, 0 or more, is a
  // configuration fault, so it is a RangeError rather than a verification
  // failure the handler would answer with a 400. NaN in particular makes
  // every comparison false, which would accept a replay of any age.
  if (
    typeof toleranceSeconds !== "number" ||
    !Number.isFinite(toleranceSeconds) ||
    toleranceSeconds < 0
  ) {
    throw new RangeError(
      `BillKit: toleranceSeconds must be a finite number of seconds, 0 or more; got ${String(toleranceSeconds)}.`,
    );
  }
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
