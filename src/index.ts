import { ERR_CANCELED } from './constants/errorCodes';
import buildURL from './core/buildURL';
import CorriereError from './core/corriereError';
import mergeConfig from './core/mergeConfig';
import { DEFAULT_RETRY_METHODS } from './core/retry';
import Corriere from './corriere';
import { logError, logRequest, logResponse } from './helpers/debug';
import { MemoryCache } from './helpers/memoryCache';
import { createRateLimiter } from './helpers/rateLimiter';
import InterceptorManager from './interceptors/interceptorManager';
import type {
  CorriereError as CorriereErrorType,
  CorriereInstance,
  CorriereRequestConfig,
  CorriereStatic,
} from './types';

function createInstance(defaultConfig: CorriereRequestConfig): CorriereInstance {
  const context = new Corriere(defaultConfig);

  const instance: any = function corriere(
    configOrUrl: string | CorriereRequestConfig,
    config?: CorriereRequestConfig,
  ) {
    return context.request(configOrUrl, config);
  };

  for (const key of Corriere.publicMethods) {
    const method: any = (context as any)[key];
    if (typeof method === 'function') {
      instance[key] = method.bind(context);
    }
  }

  instance.defaults = context.defaults;
  instance.interceptors = context.interceptors;
  instance.all = function all(promises: any[]): Promise<any[]> {
    return Promise.all(promises);
  };
  instance.spread = function spread<T>(callback: (...args: any[]) => T): (arr: any[]) => T {
    return function wrap(arr: any[]): T {
      return callback(...arr);
    };
  };
  instance.isCancel = function isCancel(value: unknown): value is CorriereErrorType {
    return !!((value as any)?.isCorriereError && (value as any).code === ERR_CANCELED);
  };
  instance.isCorriereError = function isCorriereError(value: unknown): value is CorriereErrorType {
    return (
      value instanceof CorriereError ||
      !!(value && typeof value === 'object' && (value as any).isCorriereError === true)
    );
  };
  instance.CorriereError = CorriereError;
  instance.Corriere = Corriere;
  instance.mergeConfig = mergeConfig;
  instance.buildURL = buildURL;
  instance.InterceptorManager = InterceptorManager;
  instance.createRateLimiter = createRateLimiter;
  instance.MemoryCache = MemoryCache;

  return instance as CorriereInstance;
}

const corriere = createInstance({}) as CorriereStatic;

/**
 * The `Corriere` constructor merges the library defaults into the config it is given, so
 * passing the caller's config straight through is enough — merging here as well did it twice.
 */
function create(instanceConfig?: CorriereRequestConfig): CorriereInstance {
  return createInstance(instanceConfig ?? {});
}

corriere.create = create;

export default corriere;

export type * from './types';
export {
  buildURL,
  Corriere,
  CorriereError,
  createInstance,
  createRateLimiter,
  DEFAULT_RETRY_METHODS,
  InterceptorManager,
  logError,
  logRequest,
  logResponse,
  MemoryCache,
  mergeConfig,
};
