/**
 * Retry policy for transient failures.
 *
 * Retries 5xx + network errors with jittered exponential backoff.
 * 4xx are caller-fault and never retried, with one deliberate
 * exception: `409 idempotency_in_progress`. See
 * {@link IN_PROGRESS_CODE}.
 *
 * The SDK auto-generates an `Idempotency-Key` for every mutating call
 * and reuses it across attempts, so retrying never double-charges.
 */

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialBackoffMs: number;
  readonly backoffMultiplier: number;
  readonly maxBackoffMs: number;
  readonly maxRetryAfterMs?: number;
  readonly jitter: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  initialBackoffMs: 500,
  backoffMultiplier: 2.0,
  maxBackoffMs: 8000,
  maxRetryAfterMs: 30_000,
  jitter: 0.25,
};

/**
 * Backoff before attempt `attempt` (1-indexed: attempt 2 is the first
 * retry). Caller never asks for attempt=1.
 */
export function backoffForMs(attempt: number, policy: RetryPolicy): number {
  const base = policy.initialBackoffMs * policy.backoffMultiplier ** (attempt - 2);
  const capped = Math.min(base, policy.maxBackoffMs);
  const jitterRange = capped * policy.jitter;
  const jittered = capped + (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, jittered);
}

/**
 * The one 409 error code that is transient rather than caller-fault.
 *
 * The server returns it when a request carrying the *same*
 * `Idempotency-Key` is still in flight ("Retry after a short delay",
 * `Retry-After: 1`). It is the only 4xx where doing nothing is the
 * dangerous option: the call may well have charged the customer, the
 * caller cannot see the outcome, and the obvious workaround — retry
 * with a *fresh* key — is precisely what turns one charge into two.
 *
 * Retrying is safe because the transport reuses the original
 * `Idempotency-Key` on every attempt, so the retry either loses the
 * race again or replays the first call's recorded response.
 */
export const IN_PROGRESS_CODE = "idempotency_in_progress";

export function shouldRetry(
  status: number | null,
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs?: number,
  /**
   * `error.code` from the parsed response envelope, when there was one.
   * Only consulted for 409s; every other decision is status-driven.
   */
  errorCode?: string,
): boolean {
  if (attempt >= policy.maxAttempts) return false;
  if (status === null) return true; // network error
  // A 409 from a *different* code (`idempotency_key_in_use`, a
  // conflicting subscription state) is a genuine caller-fault conflict
  // that retrying can only repeat, so it still fails fast.
  if (status === 409) return errorCode === IN_PROGRESS_CODE;
  if (status === 429) {
    // 429 is retried only when the server supplies a short, parseable
    // Retry-After value; otherwise we surface the exception so the
    // caller can decide. ``maxRetryAfterMs`` may be left ``undefined``
    // to allow any Retry-After value within budget.
    if (retryAfterMs === undefined || retryAfterMs < 0) return false;
    return policy.maxRetryAfterMs === undefined || retryAfterMs <= policy.maxRetryAfterMs;
  }
  return status >= 500;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
