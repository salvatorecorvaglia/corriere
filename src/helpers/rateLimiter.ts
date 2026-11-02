import CorriereError from '../core/corriereError';
import type { CorriereRequestConfig, CorriereResponse, RateLimiter } from '../types';

interface QueueItem {
  previous: QueueItem | null;
  next: QueueItem | null;
  queued: boolean;
  resolve: () => void;
  reject: (reason: Error) => void;
}

/** Cancellation from the limiter carries no request config: it happens before dispatch. */
function cancelledError(reason: unknown, fallbackMessage: string): CorriereError {
  return CorriereError.canceled(reason, null, { fallbackMessage });
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
  let head: QueueItem | null = null;
  let tail: QueueItem | null = null;
  let pending = 0;

  // Each waiter owns its queue node, so cancellation can unlink it without a scan.
  function remove(item: QueueItem): boolean {
    if (!item.queued) return false;
    if (item.previous) item.previous.next = item.next;
    else head = item.next;
    if (item.next) item.next.previous = item.previous;
    else tail = item.previous;
    item.previous = null;
    item.next = null;
    item.queued = false;
    pending--;
    return true;
  }

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

    if (pending >= maxQueueSize) {
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

      const item: QueueItem = {
        previous: tail,
        next: null,
        queued: true,
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

      if (tail) tail.next = item;
      else head = item;
      tail = item;
      pending++;

      if (signal) {
        onAbort = () => {
          if (remove(item)) {
            item.reject(cancelledError(signal.reason, 'Request aborted'));
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  function release(): void {
    if (destroyed) return;
    if (active <= 0) return;

    const next = head;
    if (next) {
      remove(next);
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
    while (head) {
      const item = head;
      remove(item);
      item.reject(reason);
    }
  }

  return {
    acquire,
    release,
    destroy,
    get pending() {
      return pending;
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
