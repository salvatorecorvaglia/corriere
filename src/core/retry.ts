import { ERR_BAD_OPTION, ERR_CANCELED, ERR_NETWORK, ETIMEDOUT } from '../constants/errorCodes';
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
  if (error.code === ETIMEDOUT) {
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

/**
 * Whether `config.retryMethods` lets this request be retried. A `429` always may: the server
 * refused the request without processing it, so sending it again cannot apply it twice.
 */
/**
 * The methods retried after a failure whose outcome is unknown when `retryMethods` is not
 * set: the idempotent ones, which the server can safely receive twice. `POST` and `PATCH`
 * are left out, because a retry after a dropped connection or a 5xx can apply them twice.
 */
export const DEFAULT_RETRY_METHODS: readonly string[] = Object.freeze([
  'get',
  'head',
  'options',
  'put',
  'delete',
]);

function isMethodRetryable(config: CorriereRequestConfig, is429: boolean): boolean {
  if (is429) return true;
  const allowed = config.retryMethods ?? DEFAULT_RETRY_METHODS;
  const method = (config.method || 'get').toLowerCase();
  return allowed.some((m) => m.toLowerCase() === method);
}

/**
 * A `Retry-After` header as a delay in milliseconds, or `null` when absent or unreadable.
 * The header is either whole seconds or an HTTP date; only a plain integer counts as
 * seconds, so a date is never misread by its leading digits.
 */
function parseRetryAfter(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  // A negative count is malformed but unambiguous: retry now rather than wait.
  if (/^\s*-?\d+\s*$/.test(raw)) return Math.max(0, Number.parseInt(raw, 10) * 1000);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, date.getTime() - Date.now());
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
      const shouldRetry =
        attempt < attemptLimit &&
        isMethodRetryable(config, is429) &&
        retryCondition(error as CorriereError);

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

      // `Retry-After` is how a 429 or a 503 says when to come back, so it replaces the
      // backoff for either — capped by `maxRetryDelay` like any other delay.
      const status = (error as any).response?.status;
      if (status === 429 || status === 503) {
        // `parseHeaders` lower-cases every key, so only the lower-case lookup can match.
        const retryAfter = parseRetryAfter((error as any).response?.headers?.['retry-after']);
        if (retryAfter !== null) {
          delay = Math.min(retryAfter, config.maxRetryDelay ?? 30000);
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
        // An `Error` or string reason describes the cancellation best; otherwise the sleep's
        // own rejection does.
        const reason = config.signal?.reason;
        throw CorriereErrorClass.canceled(
          reason instanceof Error || typeof reason === 'string' ? reason : sleepError,
          config,
          { response: (error as CorriereError).response ?? null },
        );
      }
    }
  }

  throw lastError;
}

export { calculateDelay, defaultRetryCondition };
export default retryRequest;
