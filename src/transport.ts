/**
 * Fetch-backed transport with retry + error mapping.
 *
 * Uses the runtime's native `fetch` (Node 20+, Bun, Deno, Cloudflare
 * Workers, browsers). The transport is the only place that touches HTTP;
 * everything else in the SDK speaks to a `Transport` interface so a
 * caller can inject a mock or replay layer for testing.
 */

import { APIConnectionError, errorFromResponse, type BillKitError } from "./errors.js";
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

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  // Loosened from ``Record<string, QueryValue>`` so resource methods
  // can pass a structurally-typed ``ListParams``-style object without
  // a cast, since TS demands an index signature otherwise.
  query?: { readonly [key: string]: QueryValue };
  body?: Record<string, unknown> | undefined;
  idempotencyKey?: string | undefined;
  extraHeaders?: Record<string, string>;
}

export interface TransportConfig {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  retryPolicy?: RetryPolicy;
  fetch?: typeof fetch;
  /**
   * Where to send the SDK's request/retry lifecycle. Omitted (the
   * default) means a no-op: the SDK stays silent and never picks a
   * destination for you. `console` works as-is; see
   * {@link BillKitLogger}. Secrets, bodies and query strings are never
   * passed to it.
   */
  logger?: BillKitLogger;
}

function userAgent(): string {
  return `billkit-node/${VERSION}`;
}

function autoIdempotencyKey(method: string, supplied?: string): string | undefined {
  if (method === "GET") return undefined;
  if (supplied !== undefined) return supplied;
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid === undefined) {
    // Deliberately fail loudly rather than fall back to
    // `Date.now()-Math.random()`. This key is what makes a retried
    // mutating call safe: two processes that generate the *same* key send
    // different requests the server treats as replays of each other, so it
    // returns the first call's response for the second, silently wrong on
    // a charge. `Math.random()` is not collision-resistant and is seeded
    // per-process, so a fleet starting together is exactly the case where
    // it collides. Every runtime this SDK supports (Node 20+, Bun, Deno,
    // Workers, modern browsers) has `crypto.randomUUID`.
    throw new Error(
      "BillKit: crypto.randomUUID() is unavailable, so a safe Idempotency-Key " +
        "cannot be generated. Use Node 20+, Bun, Deno, or Cloudflare Workers, " +
        "or pass your own `idempotencyKey` on this call.",
    );
  }
  return `sdk-${uuid}`;
}

/**
 * The URL with the **query string stripped**, for logging only.
 *
 * Never log the value {@link buildUrl} returns: list filters routinely
 * carry `?email=ada@example.com`, and copying customer PII into the
 * caller's log sink is exactly what this SDK must not do. Keeping the
 * two builders separate makes that a visible choice rather than an
 * accident waiting for someone to "simplify" it.
 */
function logSafeUrl(baseUrl: string, path: string): string {
  const normalised = path.startsWith("/") ? path : `/${path}`;
  return baseUrl.replace(/\/$/, "") + normalised;
}

function buildUrl(baseUrl: string, path: string, query: RequestOptions["query"]): string {
  const normalised = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(baseUrl.replace(/\/$/, "") + normalised);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== null && v !== undefined) {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url.toString();
}

function buildHeaders(
  apiKey: string,
  hasBody: boolean,
  idempotencyKey: string | undefined,
  extra: Record<string, string> | undefined,
): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": userAgent(),
    Accept: "application/json",
  });
  if (hasBody) headers.set("Content-Type", "application/json");
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      headers.set(k, v);
    }
  }
  return headers;
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
 * ``AbortSignal.timeout`` aborts with a ``TimeoutError`` (some runtimes
 * surface ``AbortError``); we translate that into an explicit, greppable
 * timeout message instead of the runtime's terse default.
 */
function connectionError(err: unknown, timeoutMs: number): APIConnectionError {
  const e = err as { name?: string; message?: string } | undefined;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") {
    return new APIConnectionError(`BillKit request timed out after ${timeoutMs}ms.`);
  }
  return new APIConnectionError(e?.message ?? "Network request failed.");
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
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryPolicy = config.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.logger = config.logger ?? NOOP_LOGGER;
    const fetchFn = config.fetch ?? globalThis.fetch;
    if (!fetchFn) {
      throw new Error(
        "BillKit: no global fetch implementation found. Use Node 20+, Bun, Deno, " +
          "Cloudflare Workers, or pass { fetch } in the client options.",
      );
    }
    this.fetchFn = fetchFn.bind(globalThis);
  }

  async request<T = unknown>(options: RequestOptions): Promise<T> {
    const idempotencyKey = autoIdempotencyKey(options.method, options.idempotencyKey);
    const url = buildUrl(this.baseUrl, options.path, options.query);
    const headers = buildHeaders(
      this.apiKey,
      options.body !== undefined,
      idempotencyKey,
      options.extraHeaders,
    );
    const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    // Query-free; see `logSafeUrl`. Never swap this for `url`.
    const loggedUrl = logSafeUrl(this.baseUrl, options.path);

    let lastError: BillKitError | null = null;
    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt++) {
      this.logger.debug("BillKit request", {
        method: options.method,
        url: loggedUrl,
        attempt,
        maxAttempts: this.retryPolicy.maxAttempts,
      });
      const startedAt = Date.now();
      let response: Response;
      let parsedBody: unknown;
      try {
        // ``body`` is only spread when present so a GET request goes
        // out without a body field. Some hosts (Cloudflare Workers'
        // outgoing fetch) refuse ``body: null`` on GET; omitting it
        // is the portable shape.
        //
        // ``AbortSignal.timeout`` stays armed through the *body read*
        // below, not just until the headers arrive, so a server that
        // streams headers and then stalls the body is still bounded by
        // ``timeoutMs`` instead of hanging forever. A fresh signal is
        // created per attempt because a timed-out signal can't be reused.
        const init: RequestInit = {
          method: options.method,
          headers,
          signal: AbortSignal.timeout(this.timeoutMs),
        };
        if (body !== undefined) init.body = body;
        response = await this.fetchFn(url, init);
        parsedBody = await parseJson(response);
      } catch (err) {
        lastError = connectionError(err, this.timeoutMs);
        if (!shouldRetry(null, attempt, this.retryPolicy)) throw lastError;
        const delayMs = retryDelayMs(null, attempt, this.retryPolicy);
        this.logger.warn("BillKit retrying", {
          method: options.method,
          url: loggedUrl,
          reason: (err as { name?: string } | undefined)?.name ?? "network error",
          attempt,
          delayMs,
        });
        await sleep(delayMs);
        continue;
      }

      const requestId =
        response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
      this.logger.debug("BillKit response", {
        method: options.method,
        url: loggedUrl,
        status: response.status,
        durationMs: Date.now() - startedAt,
        requestId: requestId ?? null,
      });

      if (response.ok) {
        return (parsedBody ?? undefined) as T;
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      const error = errorFromResponse({
        status: response.status,
        body: parsedBody,
        requestId,
        retryAfter: retryAfterMs === undefined ? undefined : retryAfterMs / 1000,
      });

      if (!shouldRetry(response.status, attempt, this.retryPolicy, retryAfterMs)) {
        throw error;
      }
      lastError = error;
      const delayMs = retryDelayMs(response.status, attempt, this.retryPolicy, retryAfterMs);
      this.logger.warn("BillKit retrying", {
        method: options.method,
        url: loggedUrl,
        reason: `HTTP ${response.status}`,
        attempt,
        delayMs,
      });
      await sleep(delayMs);
    }

    // Loop exhausted; surface the last seen error.
    if (lastError) throw lastError;
    throw new APIConnectionError("Retry budget exhausted with no recorded error.");
  }
}
