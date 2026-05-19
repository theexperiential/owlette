/**
 * Retry driver shared across every resource in the sdk.
 *
 * Default policy: 5 attempts, exponential backoff starting at 250ms,
 * capped at 8s, with ±25% jitter. Retries only when the operation
 * throws an `OwletteApiError` with status 429 or ≥ 500 — everything
 * else (auth failures, validation errors, scope issues) bubbles
 * immediately because the caller can't unstick them with another try.
 *
 * When the server hands back `Retry-After: <seconds>` on a 429, we
 * honor it instead of the exponential schedule. We clamp it to
 * `maxDelayMs * 2` so an abusive header can't wedge a caller forever.
 */

import { OwletteApiError } from './client';

export interface RetryOptions {
  /** Max attempts including the first. Default 5. */
  maxAttempts: number;
  /** First retry delay, ms. Default 250. */
  baseDelayMs: number;
  /** Hard cap on any single delay, ms. Default 8000. */
  maxDelayMs: number;
  /** Jitter fraction — 0.25 = ±25% of computed delay. */
  jitter: number;
  /** Predicate: should we retry this error? Default: 429 + 5xx. */
  shouldRetry: (err: unknown) => boolean;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  jitter: 0.25,
  shouldRetry: (err: unknown): boolean => {
    if (err instanceof OwletteApiError) {
      return err.status === 429 || err.status >= 500;
    }
    // Network / fetch errors are opaque — retry them.
    return true;
  },
};

/**
 * Run `op` with the merged retry policy. Returns the first success or
 * throws the last error after the policy is exhausted.
 */
export async function retry<T>(
  op: () => Promise<T>,
  override: Partial<RetryOptions> = {},
): Promise<T> {
  const policy: RetryOptions = { ...DEFAULT_RETRY, ...override };
  let lastErr: unknown;
  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (attempt === policy.maxAttempts - 1) break;
      if (!policy.shouldRetry(err)) break;
      const delay = computeDelay(policy, attempt, err);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function computeDelay(
  policy: RetryOptions,
  attempt: number,
  err: unknown,
): number {
  // Honor Retry-After on 429 if the server sent one inside the problem+json.
  if (err instanceof OwletteApiError && err.status === 429) {
    const retryAfter = err.problem.retryAfter;
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
      const ms = Math.max(0, Math.floor(retryAfter * 1000));
      return Math.min(ms, policy.maxDelayMs * 2);
    }
  }
  const expo = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * Math.pow(2, attempt),
  );
  const jitterFactor = 1 + (Math.random() * 2 - 1) * policy.jitter;
  return Math.max(0, Math.floor(expo * jitterFactor));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
