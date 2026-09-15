/**
 * Typed exception hierarchy mirroring the BillKit API error envelope.
 *
 * The API returns errors in the Stripe-shape:
 *
 *   { "error": { "type": "...", "code": "...", "message": "...", "param": "..." } }
 *
 * The HTTP **status** picks the class so callers can `catch` on the
 * subclass they care about rather than branching on status codes; the
 * envelope's `type`/`code`/`param` ride along on the thrown object.
 * See {@link classForStatus} for why the status, not `type`, is the
 * authority.
 */

export interface ErrorEnvelope {
  type?: string;
  code?: string;
  message?: string;
  param?: string;
}

export interface BillKitErrorOptions {
  type?: string | undefined;
  code?: string | undefined;
  param?: string | undefined;
  statusCode?: number | undefined;
  requestId?: string | undefined;
  rawBody?: unknown;
}

// TS treats `name = "Foo"` as a literal-type property, which then conflicts
// when subclasses override it. We widen to `string` everywhere so the
// hierarchy can re-set ``name`` cleanly.
export class BillKitError extends Error {
  override name: string = "BillKitError";
  readonly type: string | undefined;
  readonly code: string | undefined;
  readonly param: string | undefined;
  readonly statusCode: number | undefined;
  readonly requestId: string | undefined;
  readonly rawBody: unknown;

  constructor(message: string, options: BillKitErrorOptions = {}) {
    super(message);
    this.type = options.type;
    this.code = options.code;
    this.param = options.param;
    this.statusCode = options.statusCode;
    this.requestId = options.requestId;
    this.rawBody = options.rawBody;
    // Restore the prototype chain, required when targeting ES5 transpilers
    // (some bundlers still emit them) so `instanceof BillKitError` works.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class APIConnectionError extends BillKitError {
  override name = "APIConnectionError";
}

export class APIError extends BillKitError {
  override name = "APIError";
}

export class ServerError extends APIError {
  override name = "ServerError";
}

export class AuthenticationError extends BillKitError {
  override name = "AuthenticationError";
}

export class PermissionError extends BillKitError {
  override name = "PermissionError";
}

export class ResourceMissingError extends BillKitError {
  override name = "ResourceMissingError";
}

export class InvalidRequestError extends BillKitError {
  override name = "InvalidRequestError";
}

export class ConflictError extends BillKitError {
  override name = "ConflictError";
}

export class RateLimitError extends BillKitError {
  override name = "RateLimitError";
  readonly retryAfter: number | undefined;

  constructor(
    message: string,
    options: BillKitErrorOptions & { retryAfter?: number | undefined } = {},
  ) {
    super(message, options);
    this.retryAfter = options.retryAfter;
  }
}

function fallbackType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "invalid_request_error";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

/**
 * Pick the exception class from the HTTP **status**, not the envelope
 * `type`.
 *
 * The status is the field the API cannot get wrong. The `type` is
 * accurate for errors BillKit raises itself, but a request that never
 * reaches a route handler — an unmatched path, a method the route does
 * not allow — is serialised by the framework-level handler as
 * `{"type": "api_error", "code": "unhandled"}` *with a 4xx status*.
 * Trusting `type` there mapped a plain `404 Not Found` (a typo in a
 * resource id, or an SDK/API version skew) onto `ServerError`, telling
 * the caller BillKit had broken when their own request was at fault —
 * and `ServerError` is the class retry/alerting policies key on.
 *
 * The envelope `type` is still preserved verbatim on
 * {@link BillKitError.type} for callers that want it; only the class is
 * status-driven.
 */
function classForStatus(
  status: number,
): new (msg: string, opts: BillKitErrorOptions) => BillKitError {
  if (status >= 500) return ServerError;
  if (status === 401) return AuthenticationError;
  if (status === 403) return PermissionError;
  if (status === 404) return ResourceMissingError;
  if (status === 409) return ConflictError;
  if (status === 429) return RateLimitError;
  // Everything else below 500 (400, 405, 422, 451 …) is a request the
  // caller has to change.
  return InvalidRequestError;
}

export function errorFromResponse(args: {
  status: number;
  body: unknown;
  requestId?: string | undefined;
  retryAfter?: number | undefined;
}): BillKitError {
  const { status, body, requestId, retryAfter } = args;
  const envelope: ErrorEnvelope =
    typeof body === "object" && body !== null && "error" in body
      ? ((body as { error?: ErrorEnvelope }).error ?? {})
      : {};

  const type = envelope.type ?? fallbackType(status);
  const message =
    envelope.message ?? `BillKit API returned HTTP ${status} with no error body.`;

  const cls = classForStatus(status);

  const options: BillKitErrorOptions & { retryAfter?: number | undefined } = {
    type,
    code: envelope.code,
    param: envelope.param,
    statusCode: status,
    requestId,
    rawBody: typeof body === "object" && body !== null ? body : undefined,
  };
  if (cls === RateLimitError) {
    options.retryAfter = retryAfter;
  }
  return new cls(message, options);
}
