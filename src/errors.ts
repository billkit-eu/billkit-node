/**
 * The error hierarchy. Every SDK names these the same way:
 *
 *     BillKitError
 *     ├── APIError                 any HTTP error response
 *     │   ├── InvalidRequestError  400 (and any other 4xx not below)
 *     │   ├── AuthenticationError  401
 *     │   ├── PaymentError         402
 *     │   ├── PermissionDeniedError 403
 *     │   ├── NotFoundError        404
 *     │   ├── ConflictError        409
 *     │   ├── RateLimitError       429
 *     │   └── ServerError          5xx
 *     ├── APIConnectionError       the request never got an answer
 *     │   └── APITimeoutError      ...because it ran out of time
 *     └── WebhookVerificationError
 *
 * The API answers errors in one envelope:
 *
 *   { "error": { "type", "code", "message", "param", "reason", "request_id" } }
 *
 * The HTTP **status** picks the class; the envelope's fields ride along on
 * the thrown {@link APIError}. See {@link classForStatus} for why the status,
 * not `type`, is the authority.
 *
 * ## `instanceof` across module copies
 *
 * The package ships an ESM and a CommonJS build. An application that loads
 * both (one dependency `require`s the SDK, another `import`s it) has two
 * copies of every class, and an error thrown by one copy fails a plain
 * `instanceof` against the other. Every class here therefore answers
 * `instanceof` from a brand stored under a `Symbol.for` key, which is shared
 * by every copy in the process, and falls back to the prototype chain only
 * for objects that carry no brand. `name` is set on every instance as well,
 * for code that would rather compare strings.
 */

import type { APIErrorDetail } from "./generated/models.js";

/** The `code` an error envelope carries. Open: new values arrive without an SDK release. */
export type APIErrorCode = NonNullable<APIErrorDetail["code"]>;
/** The envelope's `type`, the broad class of error. Open. */
export type APIErrorType = NonNullable<APIErrorDetail["type"]>;
/** The envelope's `reason`, a finer cause some codes carry. Open. */
export type APIErrorReason = NonNullable<APIErrorDetail["reason"]>;

/**
 * The brand key. `Symbol.for` returns the same symbol to every copy of this
 * module in a process, which is the whole point: a CommonJS copy and an ESM
 * copy agree on it without sharing any other state.
 *
 * It is versioned by major. Two 1.x copies agree, but a 2.x error, whose
 * class and fields may differ, must not pass a 1.x `instanceof` and be read
 * as if it had the 1.x shape. A new major bumps the suffix.
 */
const KINDS = Symbol.for("@billkit-eu/sdk/error-kinds/v1");

type ErrorClass = { readonly kind?: string };

function brandsOf(target: ErrorClass): string[] {
  const kinds: string[] = [];
  let current: unknown = target;
  while (typeof current === "function" && current !== Error) {
    if (Object.hasOwn(current, "kind")) kinds.push((current as ErrorClass).kind as string);
    current = Object.getPrototypeOf(current);
  }
  return kinds;
}

export interface BillKitErrorOptions {
  /**
   * The underlying error, forwarded to `Error`'s own `cause`. Set on
   * `APIConnectionError` so the runtime's reason for a failed fetch
   * (`ECONNREFUSED`, a TLS failure) survives the mapping.
   */
  cause?: unknown;
}

/** The root of every error this SDK throws on purpose. */
export class BillKitError extends Error {
  /** The brand `instanceof` checks against. Every class declares its own. */
  static readonly kind: string = "BillKitError";
  override name: string = "BillKitError";

  constructor(message: string, options: BillKitErrorOptions = {}) {
    // Only pass the options bag when there is a cause: `{ cause: undefined }`
    // still installs an own `cause` property, which would show up on every
    // error that never had one.
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    Object.setPrototypeOf(this, new.target.prototype);
    Object.defineProperty(this, KINDS, {
      value: Object.freeze(brandsOf(new.target)),
      enumerable: false,
    });
  }

  /**
   * `err instanceof NotFoundError` is true for a `NotFoundError` thrown by
   * any copy of this package, ESM or CommonJS, of any 1.x version. An
   * error from another major does not match. A subclass you write yourself without a
   * `kind` of its own keeps ordinary prototype semantics.
   */
  static override [Symbol.hasInstance](instance: unknown): boolean {
    if (Object.hasOwn(this, "kind") && typeof instance === "object" && instance !== null) {
      const kinds = (instance as { [KINDS]?: unknown })[KINDS];
      if (Array.isArray(kinds)) return kinds.includes((this as ErrorClass).kind);
    }
    return Function.prototype[Symbol.hasInstance].call(this, instance);
  }
}

export interface APIErrorOptions extends BillKitErrorOptions {
  statusCode: number;
  type?: string | undefined;
  code?: string | undefined;
  param?: string | undefined;
  reason?: string | undefined;
  requestId?: string | undefined;
  /** The parsed JSON body, or the raw text when it was not JSON. */
  rawBody?: unknown;
  headers?: Headers | undefined;
}

/**
 * The API answered, and the answer was an error (or a 2xx the SDK could not
 * read). Carries everything the response said about it.
 */
export class APIError extends BillKitError {
  static override readonly kind: string = "APIError";
  override name = "APIError";
  /** The HTTP status. */
  readonly statusCode: number;
  /** The envelope's `type`. Open: compare against the values you handle. */
  readonly type: APIErrorType | undefined;
  /** The envelope's `code`, stable across releases. Open. */
  readonly code: APIErrorCode | undefined;
  /** The request parameter the error is about, when there is one. */
  readonly param: string | undefined;
  /**
   * A finer-grained cause, for the codes that have more than one. A `409
   * operation_pending` from cancelling, pausing or changing the plan of a
   * subscription whose renewal is still settling carries
   * `"renewal_processing"`. Open.
   */
  readonly reason: APIErrorReason | undefined;
  /** `X-Request-Id`. Quote it in a support request. */
  readonly requestId: string | undefined;
  /** The response body as received: parsed JSON, or text when it was not JSON. */
  readonly rawBody: unknown;
  /** The response headers. */
  readonly headers: Headers;

  constructor(message: string, options: APIErrorOptions) {
    super(message, options);
    this.statusCode = options.statusCode;
    this.type = options.type;
    this.code = options.code;
    this.param = options.param;
    this.reason = options.reason;
    this.requestId = options.requestId;
    this.rawBody = options.rawBody;
    this.headers = options.headers ?? new Headers();
  }
}

/** 400, and any other 4xx without a class of its own: change the request. */
export class InvalidRequestError extends APIError {
  static override readonly kind: string = "InvalidRequestError";
  override name = "InvalidRequestError";
}

/** 401: the key is missing, unknown or revoked. */
export class AuthenticationError extends APIError {
  static override readonly kind: string = "AuthenticationError";
  override name = "AuthenticationError";
}

/**
 * 402: the request was well-formed, but a payment it depended on could not
 * be made. Two codes arrive today: `payment_refused`, when the payment
 * provider refused a charge or refund the call had to make on the spot (no
 * money moved and nothing changed; the payment method usually needs
 * replacing), and `tenant_suspended`, when your own BillKit account is
 * suspended. Branch on `code`, and treat one you do not recognise as "this
 * payment cannot go ahead".
 */
export class PaymentError extends APIError {
  static override readonly kind: string = "PaymentError";
  override name = "PaymentError";
}

/** 403: the key is valid but its scopes do not cover the route. */
export class PermissionDeniedError extends APIError {
  static override readonly kind: string = "PermissionDeniedError";
  override name = "PermissionDeniedError";
}

/** 404, including an id that belongs to another account. */
export class NotFoundError extends APIError {
  static override readonly kind: string = "NotFoundError";
  override name = "NotFoundError";
}

/** 409: an idempotency key reused with a different body, or a state clash. */
export class ConflictError extends APIError {
  static override readonly kind: string = "ConflictError";
  override name = "ConflictError";
}

/** 429. `retryAfter` is the server's `Retry-After`, in seconds, when it sent one. */
export class RateLimitError extends APIError {
  static override readonly kind: string = "RateLimitError";
  override name = "RateLimitError";
  readonly retryAfter: number | undefined;

  constructor(message: string, options: APIErrorOptions & { retryAfter?: number | undefined }) {
    super(message, options);
    this.retryAfter = options.retryAfter;
  }
}

/** 5xx: BillKit failed. Retried automatically before it reaches you. */
export class ServerError extends APIError {
  static override readonly kind: string = "ServerError";
  override name = "ServerError";
}

/** The request never got an answer: DNS, TCP, TLS, or a reset connection. */
export class APIConnectionError extends BillKitError {
  static override readonly kind: string = "APIConnectionError";
  override name = "APIConnectionError";
}

/** The request ran out of time, per attempt, before an answer arrived. */
export class APITimeoutError extends APIConnectionError {
  static override readonly kind: string = "APITimeoutError";
  override name = "APITimeoutError";
}

/** A webhook delivery failed verification. Answer it with a 400. */
export class WebhookVerificationError extends BillKitError {
  static override readonly kind: string = "WebhookVerificationError";
  override name = "WebhookVerificationError";
}

interface ErrorEnvelope {
  type?: unknown;
  code?: unknown;
  message?: unknown;
  param?: unknown;
  reason?: unknown;
}

function fallbackType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 402) return "payment_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 409) return "conflict_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

type APIErrorClass = new (message: string, options: APIErrorOptions) => APIError;

/**
 * Pick the class from the HTTP **status**, not the envelope `type`.
 *
 * The status is the field nothing in between can get wrong. An unmatched
 * route is a 404 with `type: "invalid_request_error"` (`route_not_found`),
 * which is a `NotFoundError` here. Before 1.0 the same miss read `{"type":
 * "api_error"}` with a 4xx status, and trusting `type` turned a plain 404
 * into `ServerError`, the class retry and alerting policies key on; a proxy
 * in front of the API can still answer that way. The envelope `type` is
 * still preserved verbatim on {@link APIError.type}.
 */
function classForStatus(status: number): APIErrorClass {
  if (status >= 500) return ServerError;
  if (status === 401) return AuthenticationError;
  if (status === 402) return PaymentError;
  if (status === 403) return PermissionDeniedError;
  if (status === 404) return NotFoundError;
  if (status === 409) return ConflictError;
  if (status === 429) return RateLimitError;
  return InvalidRequestError;
}

export function errorFromResponse(args: {
  status: number;
  body: unknown;
  requestId?: string | undefined;
  retryAfter?: number | undefined;
  headers?: Headers | undefined;
}): APIError {
  const { status, body, requestId, retryAfter, headers } = args;
  const raw =
    typeof body === "object" && body !== null && "error" in body
      ? (body as { error?: unknown }).error
      : undefined;
  const envelope: ErrorEnvelope = typeof raw === "object" && raw !== null ? raw : {};

  const message =
    stringOrUndefined(envelope.message) ?? `BillKit API returned HTTP ${status} with no error body.`;
  const options: APIErrorOptions & { retryAfter?: number | undefined } = {
    statusCode: status,
    type: stringOrUndefined(envelope.type) ?? fallbackType(status),
    code: stringOrUndefined(envelope.code),
    param: stringOrUndefined(envelope.param),
    reason: stringOrUndefined(envelope.reason),
    requestId,
    rawBody: body ?? undefined,
    headers,
  };
  const cls = classForStatus(status);
  if (cls === RateLimitError) options.retryAfter = retryAfter;
  return new cls(message, options);
}
