/**
 * Fetch-backed transport with retry + error mapping.
 *
 * Uses the runtime's native `fetch` (Node 22 and 24 are what is tested).
 * The transport is the only place that touches HTTP;
 * the resources describe a call and hand it here.
 */

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  InvalidRequestError,
  errorFromResponse,
  type BillKitError,
} from "./errors.js";
import { NOOP_LOGGER, type BillKitLogger } from "./logging.js";
import {
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
  backoffForMs,
  shouldRetry,
  sleep,
} from "./retry.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.billkit.eu";
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Per-call options, accepted as the last argument of every resource method.
 *
 * ```ts
 * await client.refunds.create(
 *   { payment_id: payment.id },
 *   { idempotencyKey: `refund-${orderId}`, timeout: 10_000 },
 * );
 * ```
 */
export interface RequestOptions {
  /**
   * The `Idempotency-Key` for a mutating call. The SDK generates one
   * (`sdk-<uuid>`) when you do not, once per call, and reuses it on every
   * retry. Supply your own when a retry of *your* code has to converge on
   * the first call's result. Ignored on a `GET`.
   */
  idempotencyKey?: string | undefined;
  /**
   * Abort the call. An abort is never retried, and the call rejects with
   * the signal's `reason` (a `DOMException` named `AbortError` unless you
   * gave `abort()` one), exactly as `fetch` does.
   */
  signal?: AbortSignal | undefined;
  /** Milliseconds per attempt. Overrides the client's `timeout`. */
  timeout?: number | undefined;
  /** Retries after the first attempt. `0` disables them for this call. */
  maxRetries?: number | undefined;
  /**
   * Extra request headers. `Authorization`, `Idempotency-Key`,
   * `Content-Type` and `User-Agent` belong to the SDK and are refused here
   * (use `idempotencyKey` for the key). Every value must be a string; a
   * header whose value is `undefined` is left out.
   */
  headers?: Record<string, string | undefined> | undefined;
}

/** What a resource method asks the transport to do. Internal. */
export interface TransportRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  /**
   * Query parameters, as a plain object. {@link buildUrl} does the pruning:
   * `undefined` and `null` are dropped, an array is joined with commas (the
   * API's `expand=a,b` shape), everything else is stringified.
   */
  query?: object | undefined;
  body?: Record<string, unknown> | undefined;
  options?: RequestOptions | undefined;
  /**
   * How to read a **successful** response body. `"json"` (the default)
   * parses it; `"binary"` returns an `ArrayBuffer` (the invoice PDF);
   * `"stream"` returns the body unread as a `ReadableStream` (the account
   * export). Error responses are read as JSON on every path, so the error
   * hierarchy behaves identically.
   */
  responseType?: "json" | "binary" | "stream";
}

export interface TransportConfig {
  apiKey: string;
  baseUrl?: string | undefined;
  /** Milliseconds per attempt. Default 30000. */
  timeout?: number | undefined;
  /** Retries after the first attempt. Default 3. Overrides `retryPolicy.maxAttempts`. */
  maxRetries?: number | undefined;
  retryPolicy?: RetryPolicy | undefined;
  fetch?: typeof fetch | undefined;
  /**
   * Where to send the SDK's request/retry lifecycle. Omitted (the default)
   * means a no-op: the SDK stays silent and never picks a destination for
   * you. `console` works as-is; see {@link BillKitLogger}. Secrets, bodies
   * and query strings are never passed to it.
   */
  logger?: BillKitLogger | undefined;
}

function userAgent(): string {
  return `billkit-node/${VERSION}`;
}

/**
 * Normalises a caller's `idempotencyKey` to the header value, or
 * `undefined` for "not supplied". The type says `string`, but plain-JS
 * callers pass whatever their order id is, so a number or bigint is sent as
 * its decimal string. `null`, `undefined` and a blank string mean "generate
 * one". Anything else (a boolean, an object) is a caller bug and is
 * refused: sending it would put `true` or `[object Object]` on the wire, a
 * key every such call shares, so the server would replay one request's
 * response for another.
 */
function suppliedIdempotencyKey(supplied: unknown): string | undefined {
  if (supplied === undefined || supplied === null) return undefined;
  if (typeof supplied === "string") return supplied.trim() === "" ? undefined : supplied;
  if ((typeof supplied === "number" && Number.isFinite(supplied)) || typeof supplied === "bigint") {
    return String(supplied);
  }
  throw new TypeError(
    `BillKit: idempotencyKey must be a string (or a number), got ${
      typeof supplied === "number" ? String(supplied) : typeof supplied
    }.`,
  );
}

function autoIdempotencyKey(method: string, supplied?: unknown): string | undefined {
  if (method === "GET") return undefined;
  // A blank or whitespace-only key counts as "not supplied". Passing it
  // through used to send no header at all while the retry loop below still
  // re-sent the POST, so a caller's `idempotencyKey: process.env.X ?? ""`
  // quietly turned off the one thing that makes a retried charge safe. The
  // key is generated here, once per call and outside the retry loop, so
  // every attempt carries the same one.
  const key = suppliedIdempotencyKey(supplied);
  if (key !== undefined) return key;
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid === undefined) {
    // Fail loudly rather than fall back to `Math.random()`. Two processes
    // that generate the same key send different requests the server treats
    // as replays of each other, so it returns the first call's response for
    // the second: silently wrong on a charge.
    throw new Error(
      "BillKit: crypto.randomUUID() is unavailable, so a safe Idempotency-Key " +
        "cannot be generated. Use Node 22+, or pass your own `idempotencyKey` on this call.",
    );
  }
  return `sdk-${uuid}`;
}

function nonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`BillKit: ${name} must be a non-negative integer, got ${String(value)}.`);
  }
  return value;
}

function positiveMs(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`BillKit: ${name} must be a positive number of milliseconds, got ${String(value)}.`);
  }
  return value;
}

/**
 * The URL with the **query string stripped**, for logging only.
 *
 * Never log the value {@link buildUrl} returns: list filters routinely
 * carry `?email=ada@example.com`, and copying customer PII into the
 * caller's log sink is exactly what this SDK must not do. Keeping the two
 * builders separate makes that a visible choice rather than an accident
 * waiting for someone to "simplify" it.
 */
function logSafeUrl(baseUrl: string, path: string): string {
  const normalised = path.startsWith("/") ? path : `/${path}`;
  return baseUrl.replace(/\/$/, "") + normalised;
}

function buildUrl(baseUrl: string, path: string, query: object | undefined): string {
  const normalised = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(baseUrl.replace(/\/$/, "") + normalised);
  if (query) {
    for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      // An empty array (`expand: []`) means "nothing", and `expand=` on the
      // wire is a 400: the API reads it as one relation with an empty name.
      if (Array.isArray(v) && v.length === 0) continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
  }
  return url.toString();
}

/**
 * Headers the SDK sets itself, lower-cased. Letting `headers` replace them
 * would swap the key the client was built with, send a second idempotency
 * key the retry loop does not know about, or mislabel the JSON body, all
 * without an error; each is refused with the option that does the job.
 */
const SDK_OWNED_HEADERS: ReadonlyMap<string, string> = new Map([
  ["authorization", "The SDK sends the client's apiKey; build a client with a different apiKey instead."],
  ["idempotency-key", "Use the idempotencyKey request option: create(params, { idempotencyKey })."],
  ["content-type", "The SDK always sends JSON bodies as application/json."],
  ["user-agent", "The SDK identifies itself as billkit-node/<version>."],
]);

/**
 * Validate the caller's `headers` and return the ones to send. Refuses an
 * SDK-owned name (case-insensitive) and a value that is not a string;
 * skips a value that is `undefined`.
 */
export function checkExtraHeaders(extra: unknown): [string, string][] {
  if (extra === undefined || extra === null) return [];
  if (typeof extra !== "object" || Array.isArray(extra) || extra instanceof Headers) {
    throw new TypeError(
      "BillKit: headers must be a plain object of header names to string values, " +
        `got ${Array.isArray(extra) ? "an array" : extra instanceof Headers ? "a Headers instance" : typeof extra}.`,
    );
  }
  const out: [string, string][] = [];
  for (const [name, value] of Object.entries(extra as Record<string, unknown>)) {
    if (value === undefined) continue;
    const owned = SDK_OWNED_HEADERS.get(name.toLowerCase());
    if (owned !== undefined) {
      const keyHint =
        name.toLowerCase() === "idempotency-key"
          ? ""
          : " Of the headers the SDK owns, only Idempotency-Key is yours to choose, through idempotencyKey.";
      throw new TypeError(`BillKit: headers cannot set "${name}", which the SDK owns. ${owned}${keyHint}`);
    }
    if (typeof value !== "string") {
      throw new TypeError(
        `BillKit: header "${name}" must be a string, got ${value === null ? "null" : typeof value}.`,
      );
    }
    out.push([name, value]);
  }
  return out;
}

function buildHeaders(
  apiKey: string,
  hasBody: boolean,
  idempotencyKey: string | undefined,
  extra: readonly [string, string][],
): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": userAgent(),
    Accept: "application/json",
  });
  if (hasBody) headers.set("Content-Type", "application/json");
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  for (const [k, v] of extra) headers.set(k, v);
  return headers;
}

/** `undefined` when `text` is empty or not JSON; the parsed value otherwise. */
function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false } {
  if (!text) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

interface ReadBody {
  /** Parsed JSON on the JSON path, or for an error response on any path. */
  parsed: unknown;
  /** The body text when it was not JSON, kept for `rawBody`. */
  text: string | undefined;
  json: boolean;
  binary: ArrayBuffer | undefined;
  stream: ReadableStream<Uint8Array> | undefined;
}

/**
 * Read the body once, as the caller asked for it.
 *
 * A `Response` body can only be consumed once, so the choice is made here
 * rather than after the status check. A *failed* response is decoded as
 * JSON on every path: an error is an error envelope no matter which
 * endpoint produced it.
 */
async function readBody(
  response: Response,
  responseType: "json" | "binary" | "stream",
): Promise<ReadBody> {
  if (response.ok && responseType === "stream") {
    return {
      parsed: undefined,
      text: undefined,
      json: false,
      binary: undefined,
      stream: response.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
    };
  }
  if (response.ok && responseType === "binary") {
    return {
      parsed: undefined,
      text: undefined,
      json: false,
      binary: await response.arrayBuffer(),
      stream: undefined,
    };
  }
  const text = await response.text();
  const result = parseJsonText(text);
  return result.ok
    ? { parsed: result.value, text: undefined, json: true, binary: undefined, stream: undefined }
    : { parsed: undefined, text, json: false, binary: undefined, stream: undefined };
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const n = Number.parseFloat(header);
  if (Number.isFinite(n) && n >= 0) return n * 1000;

  const retryAt = Date.parse(header);
  if (Number.isNaN(retryAt)) return undefined;
  return Math.max(0, retryAt - Date.now());
}

function retryDelayMs(
  status: number | null,
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs?: number,
): number {
  if (status === 429 && retryAfterMs !== undefined) return retryAfterMs;
  return backoffForMs(attempt + 1, policy);
}

/**
 * Map a thrown fetch/read error to an {@link APIConnectionError}.
 *
 * The original error is attached as `cause` either way. Node's fetch
 * reports every transport failure as the same "fetch failed" message and
 * puts the real reason (`ECONNREFUSED`, `ENOTFOUND`, a TLS error) in its own
 * cause, so dropping it left the caller with nothing to diagnose.
 */
function connectionError(err: unknown, timedOut: boolean, timeoutMs: number): APIConnectionError {
  if (timedOut) {
    return new APITimeoutError(`BillKit request timed out after ${timeoutMs}ms.`, { cause: err });
  }
  const e = err as { message?: string } | undefined;
  return new APIConnectionError(e?.message ?? "Network request failed.", { cause: err });
}

/**
 * A 3xx that `redirect: "manual"` stopped at. Node and Workers hand back
 * the real status; browsers hand back an opaque `status: 0` response with
 * `type: "opaqueredirect"`, so both shapes count.
 */
function isRedirect(response: Response): boolean {
  return (
    response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)
  );
}

function redirectError(response: Response, requestId: string | undefined): BillKitError {
  const status = response.status;
  return new InvalidRequestError(
    `BillKit API answered HTTP ${status || "3xx"} with a redirect, which the SDK does not ` +
      "follow on API calls. Check that `baseUrl` is the API origin itself " +
      "(https://api.billkit.eu), with no path and no proxy rewriting it.",
    {
      statusCode: status,
      type: "invalid_request_error",
      requestId,
      headers: response.headers,
    },
  );
}

/**
 * Pass a streamed body through unchanged, but map a failure partway
 * through it to {@link APIConnectionError}.
 *
 * Once the headers are in, the body is read on the caller's schedule, and a
 * connection dropped mid-body surfaces from the runtime as a bare
 * `TypeError: terminated`, which no `instanceof BillKitError` handler
 * catches. A caller's own abort is the exception: it errors with the
 * signal's reason, the same as an abort before the headers.
 */
function mapStreamErrors(
  body: ReadableStream<Uint8Array>,
  userSignal: AbortSignal | undefined,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (userSignal?.aborted) {
            controller.error(abortReason(userSignal));
            return;
          }
          const reason = (err as { message?: unknown } | undefined)?.message;
          controller.error(
            new APIConnectionError(
              "BillKit: the connection failed while the response body was being read" +
                (typeof reason === "string" && reason ? ` (${reason}).` : "."),
              { cause: err },
            ),
          );
          return;
        }
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/** The abort reason a caller's signal carries, as `fetch` would surface it. */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

export class Transport {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly fetchFn: typeof fetch;
  private readonly logger: BillKitLogger;

  constructor(config: TransportConfig) {
    if (!config.apiKey) {
      throw new Error("BillKit: an API key is required (config.apiKey or BILLKIT_API_KEY env).");
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = positiveMs(config.timeout, "timeout") ?? DEFAULT_TIMEOUT_MS;
    const policy = config.retryPolicy ?? DEFAULT_RETRY_POLICY;
    const maxRetries = nonNegativeInteger(config.maxRetries, "maxRetries");
    this.retryPolicy = maxRetries === undefined ? policy : { ...policy, maxAttempts: maxRetries + 1 };
    this.logger = config.logger ?? NOOP_LOGGER;
    const fetchFn = config.fetch ?? globalThis.fetch;
    if (!fetchFn) {
      throw new Error(
        "BillKit: no global fetch implementation found. Use Node 22+, " +
          "or pass { fetch } in the client options.",
      );
    }
    this.fetchFn = fetchFn.bind(globalThis);
  }

  async request<T>(req: TransportRequest): Promise<T> {
    const options = req.options ?? {};
    const extraHeaders = checkExtraHeaders(options.headers);
    const responseType = req.responseType ?? "json";
    const idempotencyKey = autoIdempotencyKey(req.method, options.idempotencyKey);
    const timeoutMs = positiveMs(options.timeout, "timeout") ?? this.timeoutMs;
    const maxRetries = nonNegativeInteger(options.maxRetries, "maxRetries");
    const policy: RetryPolicy =
      maxRetries === undefined ? this.retryPolicy : { ...this.retryPolicy, maxAttempts: maxRetries + 1 };
    const userSignal = options.signal;
    const url = buildUrl(this.baseUrl, req.path, req.query);
    const headers = buildHeaders(this.apiKey, req.body !== undefined, idempotencyKey, extraHeaders);
    const body = req.body !== undefined ? JSON.stringify(req.body) : undefined;
    // Query-free; see `logSafeUrl`. Never swap this for `url`.
    const loggedUrl = logSafeUrl(this.baseUrl, req.path);

    let lastError: BillKitError | null = null;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      if (userSignal?.aborted) throw abortReason(userSignal);
      this.logger.debug("BillKit request", {
        method: req.method,
        url: loggedUrl,
        attempt,
        maxAttempts: policy.maxAttempts,
      });
      const startedAt = Date.now();
      // One timer per attempt, armed through the body read so a server that
      // sends headers and then stalls the body is still bounded. A stream is
      // the exception: its body is the caller's to read, at their pace, so
      // its timer stops once the headers are in.
      const timer = new AbortController();
      let timedOut = false;
      const handle = setTimeout(() => {
        timedOut = true;
        timer.abort(new DOMException(`timed out after ${timeoutMs}ms`, "TimeoutError"));
      }, timeoutMs);
      const signal = userSignal ? AbortSignal.any([timer.signal, userSignal]) : timer.signal;

      let response: Response;
      let read: ReadBody;
      try {
        // `body` is only set when present so a GET goes out without one.
        // Some hosts (Cloudflare Workers' outgoing fetch) refuse
        // `body: null` on GET.
        const init: RequestInit = { method: req.method, headers, signal };
        // Never follow a redirect on an API call. Following one re-sends
        // the method, the JSON body (customer PII) and the Idempotency-Key
        // to wherever `Location` points. The API never redirects a `/v1`
        // call, so a 3xx means a misconfigured `baseUrl`. The PDF path is
        // the exception: the storage adapter answers `302` to a presigned
        // URL, and fetch drops `Authorization` on that cross-origin hop.
        if (responseType !== "binary") init.redirect = "manual";
        if (body !== undefined) init.body = body;
        response = await this.fetchFn(url, init);
        if (responseType === "stream" && response.ok) clearTimeout(handle);
        read = await readBody(response, responseType);
      } catch (err) {
        clearTimeout(handle);
        if (userSignal?.aborted) throw abortReason(userSignal);
        lastError = connectionError(err, timedOut, timeoutMs);
        if (!shouldRetry(null, attempt, policy)) throw lastError;
        const delayMs = retryDelayMs(null, attempt, policy);
        this.logger.warn("BillKit retrying", {
          method: req.method,
          url: loggedUrl,
          reason: timedOut ? "timeout" : ((err as { name?: string } | undefined)?.name ?? "network error"),
          attempt,
          delayMs,
        });
        await sleep(delayMs, userSignal);
        continue;
      }
      clearTimeout(handle);

      const requestId =
        response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
      this.logger.debug("BillKit response", {
        method: req.method,
        url: loggedUrl,
        status: response.status,
        durationMs: Date.now() - startedAt,
        requestId: requestId ?? null,
      });

      if (response.ok) {
        if (responseType === "stream") {
          return mapStreamErrors(read.stream as ReadableStream<Uint8Array>, userSignal) as T;
        }
        if (responseType === "binary") return read.binary as T;
        if (!read.json) {
          // A 2xx the SDK cannot read is not a success it can hand back: the
          // caller's code would go on to read fields off `undefined`. It is
          // usually a proxy or captive portal answering in BillKit's place.
          throw new APIError(
            `BillKit API answered HTTP ${response.status} with a body that is not JSON` +
              `${read.text ? "" : " (it was empty)"}. Check that \`baseUrl\` points at the API.`,
            {
              statusCode: response.status,
              requestId,
              rawBody: read.text,
              headers: response.headers,
            },
          );
        }
        return read.parsed as T;
      }

      if (isRedirect(response)) throw redirectError(response, requestId);

      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      const error = errorFromResponse({
        status: response.status,
        body: read.json ? read.parsed : read.text,
        requestId,
        retryAfter: retryAfterMs === undefined ? undefined : retryAfterMs / 1000,
        headers: response.headers,
      });

      // `error.code` is what separates a transient `409
      // idempotency_in_progress` from every other (permanent) 409; see
      // `IN_PROGRESS_CODE`. The key on the wire is unchanged across
      // attempts, so the retry replays rather than re-charges.
      if (!shouldRetry(response.status, attempt, policy, retryAfterMs, error.code)) {
        throw error;
      }
      lastError = error;
      const delayMs = retryDelayMs(response.status, attempt, policy, retryAfterMs);
      this.logger.warn("BillKit retrying", {
        method: req.method,
        url: loggedUrl,
        reason: `HTTP ${response.status}`,
        attempt,
        delayMs,
      });
      await sleep(delayMs, userSignal);
    }

    // Loop exhausted; surface the last seen error.
    if (lastError) throw lastError;
    throw new APIConnectionError("Retry budget exhausted with no recorded error.");
  }
}
