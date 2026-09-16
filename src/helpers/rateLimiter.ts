import { ERR_CANCELED } from '../constants/errorCodes';
import CorriereError from '../core/corriereError';
import type { CorriereRequestConfig, CorriereResponse, RateLimiter } from '../types';

interface QueueItem {
  resolve: () => void;
  reject: (reason: Error) => void;
}

/**
 * Wraps a cancellation reason as an `CorriereError` carrying `ERR_CANCELED`.
 *
 * Rejecting with a bare `Error` made aborts that happened while a request was still queued
 * invisible to `corriere.isCancel()` and to `defaultRetryCondition` (which keys off
 * `error.code`), so a cancelled request looked like an unclassified failure.
 */
function cancelledError(reason: unknown, fallback: string): CorriereError {
  const message =
    reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : fallback;
  const err = new CorriereError(message, ERR_CANCELED, null, null, null);
  if (reason instanceof Error) err.cause = reason;
  return err;
}

export function createRateLimiter(
  maxConcurrent: number = Number.POSITIVE_INFINITY,
  maxQueueSize: number = Number.POSITIVE_INFINITY,
): RateLimiter {
  if (
    maxConcurrent !== Number.POSITIVE_INFINITY &&
    (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)
  ) {
    throw new RangeError(
      `[Corriere] maxConcurrent must be a positive integer or Infinity, got: ${maxConcurrent}`,
    );
  }
  if (
    maxQueueSize !== Number.POSITIVE_INFINITY &&
    (!Number.isInteger(maxQueueSize) || maxQueueSize < 1)
  ) {
    throw new RangeError(
      `[Corriere] maxQueueSize must be a positive integer or Infinity, got: ${maxQueueSize}`,
    );
  }
  let active = 0;
  let destroyed = false;
  const queue: QueueItem[] = [];

  function acquire(signal?: AbortSignal): Promise<void> {
    if (destroyed) {
      return Promise.reject(cancelledError(null, '[Corriere] Rate limiter has been destroyed'));
    }

    if (signal?.aborted) {
      return Promise.reject(cancelledError(signal.reason, 'Request aborted'));
    }

    if (active < maxConcurrent) {
      active++;
      return Promise.resolve();
    }

    if (queue.length >= maxQueueSize) {
      return Promise.reject(
        new CorriereError(
          `[Corriere] Rate limiter queue size exceeded maxQueueSize (${maxQueueSize})`,
          CorriereError.ERR_RATE_LIMIT_QUEUE_FULL,
          null,
          null,
          null,
        ),
      );
    }

    return new Promise((resolve, reject) => {
      let onAbort: (() => void) | undefined;

      const item = {
        resolve: () => {
          if (signal && onAbort) {
            signal.removeEventListener('abort', onAbort);
          }
          resolve();
        },
        reject: (err: Error) => {
          if (signal && onAbort) {
            signal.removeEventListener('abort', onAbort);
          }
          reject(err);
        },
      };

      queue.push(item);

      if (signal) {
        onAbort = () => {
          const index = queue.indexOf(item);
          if (index !== -1) {
            queue.splice(index, 1);
          }
          reject(cancelledError(signal.reason, 'Request aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  function release(): void {
    if (destroyed) return;
    if (active <= 0) return;

    const next = queue.shift();
    if (next) {
      next.resolve();
      return;
    }
    active--;
  }

  function destroy(): void {
    destroyed = true;
    const reason = cancelledError(
      null,
      '[Corriere] Rate limiter destroyed — pending request cancelled',
    );
    while (queue.length > 0) {
      queue.shift()!.reject(reason);
    }
  }

  return {
    acquire,
    release,
    destroy,
    get pending() {
      return queue.length;
    },
    get active() {
      return active;
    },
    get destroyed() {
      return destroyed;
    },
  };
}

export async function rateLimitedRequest<T = unknown>(
  dispatchFn: (config: CorriereRequestConfig) => Promise<CorriereResponse<T>>,
  limiter: RateLimiter,
  config: CorriereRequestConfig,
): Promise<CorriereResponse<T>> {
  await limiter.acquire(config.signal);
  try {
    return await dispatchFn(config);
  } finally {
    limiter.release();
  }
}

export default createRateLimiter;
