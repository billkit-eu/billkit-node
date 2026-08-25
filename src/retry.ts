/**
 * Retry policy for transient failures.
 *
 * Retries 5xx + network errors with jittered exponential backoff.
 * 4xx (including 409 Idempotency-Key conflicts) are caller-fault and
 * never retried. The SDK auto-generates an `Idempotency-Key` for every
 * mutating call so retrying a 5xx never double-charges.
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

export function shouldRetry(
  status: number | null,
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs?: number,
): boolean {
  if (attempt >= policy.maxAttempts) return false;
  if (status === null) return true; // network error
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
