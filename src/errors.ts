/**
 * Typed exception hierarchy mirroring the BillKit API error envelope.
 *
 * The API returns errors in the Stripe-shape:
 *
 *   { "error": { "type": "...", "code": "...", "message": "...", "param": "..." } }
 *
 * Each `type` maps to one error class so callers can `catch` on the
 * subclass they care about rather than branching on HTTP status codes.
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

const TYPE_TO_CLASS: Record<string, new (msg: string, opts: BillKitErrorOptions) => BillKitError> =
  {
    api_connection_error: APIConnectionError,
    // ``api_error`` is the Stripe-convention type for 5xx, so surface it as
    // ServerError (a subclass of APIError) so `catch (e instanceof
    // ServerError)` works without false negatives.
    api_error: ServerError,
    authentication_error: AuthenticationError,
    permission_error: PermissionError,
    invalid_request_error: InvalidRequestError,
    idempotency_error: ConflictError,
    conflict: ConflictError,
    rate_limit_error: RateLimitError,
  };

function fallbackType(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "invalid_request_error";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

function fallbackClass(
  status: number,
): new (msg: string, opts: BillKitErrorOptions) => BillKitError {
  if (status === 401) return AuthenticationError;
  if (status === 403) return PermissionError;
  if (status === 404) return ResourceMissingError;
  if (status === 409) return ConflictError;
  if (status === 429) return RateLimitError;
  if (status >= 500) return ServerError;
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

  let cls = TYPE_TO_CLASS[type] ?? fallbackClass(status);
  if (status === 404 && cls === InvalidRequestError) cls = ResourceMissingError;
  if (status === 409 && cls === InvalidRequestError) cls = ConflictError;

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
