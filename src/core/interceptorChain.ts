import type { CorriereRequestConfig, InterceptorHandler } from '../types';
import CorriereError from './corriereError';

/**
 * The interceptor runners behind `Corriere.request()`. They take the already-filtered,
 * already-ordered handler lists, so they hold no client state and can be tested alone.
 */

/**
 * A synchronous interceptor that returns a promise is a configuration error: the request
 * fails with `ERR_BAD_OPTION` and the promise is discarded. It is still marked handled
 * first — nothing else will ever observe it, and if it rejects, an unhandled rejection
 * terminates a Node process by default.
 */
function rejectPromiseResult(result: unknown, startConfig: CorriereRequestConfig): never {
  (result as PromiseLike<unknown>).then(undefined, () => {});
  throw new CorriereError(
    'Synchronous request interceptors cannot return a Promise.',
    CorriereError.ERR_BAD_OPTION,
    startConfig,
    null,
    null,
  );
}

export function runRequestInterceptorsSync(
  startConfig: CorriereRequestConfig,
  interceptors: InterceptorHandler[],
): CorriereRequestConfig {
  let cfg = startConfig;
  let rejectReason: any = null;
  let isRejected = false;

  for (const interceptor of interceptors) {
    if (!isRejected) {
      try {
        if (interceptor.fulfilled) {
          cfg = (interceptor.fulfilled as any)(cfg) as CorriereRequestConfig;
          if (cfg && typeof (cfg as any).then === 'function') {
            rejectPromiseResult(cfg, startConfig);
          }
        }
      } catch (err) {
        rejectReason = err;
        isRejected = true;
      }
    } else if (interceptor.rejected) {
      try {
        cfg = interceptor.rejected(rejectReason) as CorriereRequestConfig;
        if (cfg && typeof (cfg as any).then === 'function') {
          rejectPromiseResult(cfg, startConfig);
        }
        isRejected = false;
      } catch (err) {
        rejectReason = err;
        isRejected = true;
      }
    }
  }

  if (isRejected) {
    throw rejectReason;
  }
  return cfg;
}

export function runRequestInterceptorsAsync(
  startConfig: CorriereRequestConfig,
  interceptors: InterceptorHandler[],
): Promise<CorriereRequestConfig> {
  let promise: Promise<any> = Promise.resolve(startConfig);
  for (const interceptor of interceptors) {
    promise = promise.then(
      (value: any) => (interceptor.fulfilled ? (interceptor.fulfilled as any)(value) : value),
      interceptor.rejected ?? undefined,
    );
  }
  return promise as Promise<CorriereRequestConfig>;
}

/**
 * Runs response interceptors over a settled request. `initialRejected` says whether the
 * request failed; from there each handler's outcome decides whether the next one sees a
 * value (`fulfilled`) or an error (`rejected`), as in a promise chain.
 */
export async function runResponseInterceptors(
  initialValue: any,
  initialRejected: boolean,
  interceptors: InterceptorHandler[],
): Promise<any> {
  let current = initialValue;
  let isRejected = initialRejected;
  for (const interceptor of interceptors) {
    if (!isRejected) {
      try {
        if (interceptor.fulfilled) {
          const result = (interceptor.fulfilled as any)(current);
          if (result && typeof result.then === 'function') {
            current = await result;
          } else {
            current = result;
          }
        }
      } catch (err) {
        current = err;
        isRejected = true;
      }
    } else if (interceptor.rejected) {
      try {
        const result = interceptor.rejected(current) as any;
        if (result && typeof result.then === 'function') {
          current = await result;
        } else {
          current = result;
        }
        isRejected = false;
      } catch (err) {
        current = err;
        isRejected = true;
      }
    }
  }
  if (isRejected) {
    throw current;
  }
  return current;
}
