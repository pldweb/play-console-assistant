/**
 * Small, explicit retry policy.
 *
 * - Only errors classified as retryable are retried.
 * - Non-idempotent operations are never retried automatically.
 * - Before every retry `beforeRetry` runs; it inspects the page and may
 *   report that the previous attempt actually succeeded ('done'), in which
 *   case the operation is not repeated.
 */
import { isRetryable, toPCAError } from '../services/errors.js';

export function backoffDelay(attempt, baseDelayMs) {
  return baseDelayMs * 2 ** (attempt - 1);
}

export function createRetryPolicy({ retryLimit = 2, baseDelayMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  /**
   * @param {(attempt:number) => Promise<any>} op
   * @param {{ idempotent?: boolean, beforeRetry?: (err, attempt) => Promise<'done'|'retry'|'stop'>, onAttemptFailed?: Function }} opts
   * @returns {Promise<{ value?: any, recovered?: boolean, attempts: number }>}
   */
  async function run(op, { idempotent = true, beforeRetry = null, onAttemptFailed = null } = {}) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return { value: await op(attempt), attempts: attempt };
      } catch (e) {
        const err = toPCAError(e);
        if (onAttemptFailed) await onAttemptFailed(err, attempt);
        const canRetry = idempotent && isRetryable(err.code) && attempt <= retryLimit;
        if (!canRetry) throw err;
        if (beforeRetry) {
          const decision = await beforeRetry(err, attempt);
          if (decision === 'done') return { recovered: true, attempts: attempt };
          if (decision === 'stop') throw err;
        }
        await sleep(backoffDelay(attempt, baseDelayMs));
      }
    }
  }
  return { run, retryLimit };
}
