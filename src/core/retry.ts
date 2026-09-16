import {
  ECONNABORTED,
  ERR_BAD_OPTION,
  ERR_CANCELED,
  ERR_NETWORK,
  ETIMEDOUT,
} from '../constants/errorCodes';
import type {
  CorriereError,
  CorriereRequestConfig,
  OnRetryFunction,
  RetryConditionFunction,
} from '../types';
import CorriereErrorClass, { FROM_CACHE } from './corriereError';

function isUnretriableBody(data: unknown): boolean {
  if (data == null) return false;
  if (typeof ReadableStream !== 'undefined' && data instanceof ReadableStream) return true;
  if (data && typeof (data as any).pipe === 'function') return true;
  return false;
}

function defaultRetryCondition(error: any): boolean {
  if (error.code === ERR_CANCELED) {
    return false;
  }

  if (error.code === ERR_NETWORK) {
    return true;
  }

  // A timeout is the same class of failure as a dropped connection — the request did not
  // get an answer — and it is the single most common reason to want a retry. It was
  // previously excluded, which made `{ timeout, retry }` together look configured but do
  // nothing. Cancellation stays non-retryable above: the caller asked to stop.
  if (error.code === ETIMEDOUT || error.code === ECONNABORTED) {
    return true;
  }

  if (error.response && error.response.status >= 500) {
    return true;
  }

  if (error.config?.retryOn429 && error.response && error.response.status === 429) {
    return true;
  }

  return false;
}

function calculateDelay(attempt: number, baseDelay: number, maxDelay = 30000): number {
  const exponentialDelay = baseDelay * 2 ** attempt;
  const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);
  const calculated = Math.round(exponentialDelay + jitter);
  return Math.min(calculated, maxDelay);
}

function sleep(ms: number, options?: { signal?: AbortSignal }): Promise<void> {
  return new Promise((resolve, reject) => {
    let onAbort: (() => void) | undefined;

    const timeoutId = setTimeout(() => {
      if (options?.signal && onAbort) {
        options.signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);

    if (options?.signal) {
      if (options.signal.aborted) {
        clearTimeout(timeoutId);
        return reject(options.signal.reason || new Error('Sleep aborted'));
      }

      onAbort = () => {
        clearTimeout(timeoutId);
        reject(options.signal!.reason || new Error('Sleep aborted'));
      };

      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function retryRequest(
  dispatchFn: (config: CorriereRequestConfig) => Promise<any>,
  config: CorriereRequestConfig,
): Promise<any> {
  const maxRetries = config.retry ?? 0;

  if (maxRetries <= 0 && !config.retryOn429) {
    return dispatchFn(config);
  }

  const retryDelay = config.retryDelay ?? 1000;
  const retryCondition: RetryConditionFunction = config.retryCondition ?? defaultRetryCondition;

  let lastError: any;
  // `retryOn429` is an independent opt-in: it grants up to 3 retries for 429 responses
  // even when `retry` is 0, without making any other error retryable.
  const actualMaxRetries = Math.max(maxRetries, config.retryOn429 ? 3 : 0);

  for (let attempt = 0; attempt <= actualMaxRetries; attempt++) {
    try {
      const response = await dispatchFn(config);
      return response;
    } catch (error) {
      lastError = error;

      // A replayed cache hit fails the same way on every attempt — the request never
      // reaches the network — so retrying only spends the backoff schedule. Checked
      // ahead of `retryCondition` because this holds regardless of what the caller's
      // condition would say.
      if ((error as any)?.[FROM_CACHE]) {
        throw error;
      }

      const is429 = (error as any).response?.status === 429;
      const attemptLimit = is429 && config.retryOn429 ? Math.max(maxRetries, 3) : maxRetries;
      const shouldRetry = attempt < attemptLimit && retryCondition(error as CorriereError);

      if (!shouldRetry) {
        throw error;
      }

      if (isUnretriableBody(config.data)) {
        const unretriable = new CorriereErrorClass(
          'Request body is a ReadableStream and cannot be retried after consumption. ' +
            'Buffer the stream upstream or set retry: 0 for this call.',
          ERR_BAD_OPTION,
          config,
          null,
          (error as CorriereError).response ?? null,
        );
        // Without this the failure that actually triggered the retry — usually a network
        // error — is unrecoverable by the caller, who only sees "body is not retriable".
        if (error instanceof Error) {
          unretriable.cause = error;
        }
        throw unretriable;
      }

      let delay = calculateDelay(attempt, retryDelay, config.maxRetryDelay ?? 30000);

      if (config.retryOn429 && (error as any).response?.status === 429) {
        // `parseHeaders` lower-cases every key, so only the lower-case lookup can match.
        const headers = (error as any).response?.headers;
        const retryAfterStr = headers?.['retry-after'];
        if (retryAfterStr) {
          const parsed = Number.parseInt(retryAfterStr, 10);
          if (!Number.isNaN(parsed)) {
            delay = Math.max(0, parsed * 1000);
          } else {
            const date = new Date(retryAfterStr);
            if (!Number.isNaN(date.getTime())) {
              delay = Math.max(0, date.getTime() - Date.now());
            }
          }
          const maxDelay = config.maxRetryDelay ?? 30000;
          if (delay > maxDelay) {
            delay = maxDelay;
          }
        }
      }

      // A throwing observer must not replace the error being retried, nor abort the loop.
      if (typeof config.onRetry === 'function') {
        try {
          (config.onRetry as OnRetryFunction)(attempt + 1, error as CorriereError, config);
        } catch {
          // onRetry is a notification hook; its failure is not the request's failure.
        }
      }

      try {
        await sleep(delay, { signal: config.signal });
      } catch (sleepError) {
        const reason = config.signal?.reason;
        const message =
          reason instanceof Error
            ? reason.message
            : typeof reason === 'string'
              ? reason
              : (sleepError as Error).message || 'Request aborted';
        const err = new CorriereErrorClass(
          message,
          ERR_CANCELED,
          config,
          null,
          (error as CorriereError).response ?? null,
        );
        if (reason instanceof Error) {
          err.cause = reason;
        } else if (sleepError instanceof Error) {
          err.cause = sleepError;
        }
        throw err;
      }
    }
  }

  throw lastError;
}

export { calculateDelay, defaultRetryCondition };
export default retryRequest;
