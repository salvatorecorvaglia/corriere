import { resolveURL } from './core/buildURL';
import CorriereError from './core/corriereError';
import {
  runRequestInterceptorsAsync,
  runRequestInterceptorsSync,
  runResponseInterceptors,
} from './core/interceptorChain';
import mergeConfig from './core/mergeConfig';
import dispatchRequest, { cacheKeyFor, createRegistry, type RequestRegistry } from './core/request';
import retryRequest from './core/retry';
import defaultsConfig from './defaults/index';
import { paginate } from './features/paginate';
import { readStreamBody } from './features/stream';
import { logError, logRequest, logResponse } from './helpers/debug';
import { rateLimitedRequest } from './helpers/rateLimiter';
import { toFormData } from './helpers/toFormData';
import InterceptorManager from './interceptors/interceptorManager';
import type {
  CorriereRequestConfig,
  CorriereResponse,
  InterceptorHandler,
  Interceptors,
  InternalConfig,
  Method,
} from './types';

/**
 * Builds a per-call config from the caller's config plus the fixed fields a shorthand
 * method supplies (`method`, `url`, sometimes `data`).
 *
 * This deliberately does NOT use `mergeConfig`: that helper strips `url`, `data` and
 * `signal` from its first argument so that an instance's *defaults* cannot leak
 * request-scoped values into every call. The caller's config is not a defaults object,
 * so running it through `mergeConfig` silently discarded the caller's `signal` (making
 * requests uncancellable) and `data` (dropping `delete` bodies). `request()` still
 * merges the result against `this.defaults`, which is where that stripping belongs.
 */
function withRequestFields(
  config: CorriereRequestConfig | undefined,
  fields: { method: Method; url: string; data?: unknown },
): CorriereRequestConfig {
  const merged: CorriereRequestConfig = { ...config, method: fields.method, url: fields.url };
  if (fields.data !== undefined) {
    merged.data = fields.data;
  }
  return merged;
}

function dispatchAndRetry(
  cfg: CorriereRequestConfig,
  registry: RequestRegistry,
): Promise<CorriereResponse> {
  const fullUrl = resolveURL(cfg);
  logRequest(cfg, fullUrl);

  const enrichedCfg: InternalConfig = { ...cfg, _builtUrl: fullUrl };

  // Bound to this client's registry, so dedupe and caching never reach across instances.
  const dispatch = (config: CorriereRequestConfig) => dispatchRequest(config, registry);

  const dispatchFn = cfg.rateLimiter
    ? (config: CorriereRequestConfig) => rateLimitedRequest(dispatch, config.rateLimiter!, config)
    : dispatch;

  return retryRequest(dispatchFn, enrichedCfg);
}

export class Corriere {
  static readonly publicMethods = [
    'request',
    'getUri',
    'get',
    'delete',
    'head',
    'options',
    'post',
    'put',
    'patch',
    'postForm',
    'putForm',
    'patchForm',
    'stream',
    'autoPaginate',
    'gql',
    'clearCache',
    'invalidate',
  ] as const;

  defaults: CorriereRequestConfig;
  interceptors: Interceptors;
  /** This client's own dedupe and cache state. See `RequestRegistry`. */
  private readonly registry: RequestRegistry;

  constructor(instanceConfig: CorriereRequestConfig = {}) {
    this.defaults = mergeConfig(defaultsConfig, instanceConfig);
    this.interceptors = {
      request: new InterceptorManager(),
      response: new InterceptorManager(),
    };
    this.registry = createRegistry();
  }

  /**
   * Empties this client's built-in response cache.
   *
   * Only the built-in cache: a `config.cache` provider you supplied is yours to manage.
   */
  clearCache(): void {
    void this.registry.cache.clear();
  }

  /**
   * Drops the cached response for one request, if there is one.
   *
   * Takes the same arguments a `get()` would, so callers never have to reconstruct a cache
   * key — `cacheKeyFor` derives it exactly as the request pipeline does.
   *
   * The key is derived from the instance defaults plus `config`; request interceptors do not
   * run here. If an interceptor adds a header to the cached request (an auth token, say),
   * pass that header in `config` too, or the key will not match and nothing is dropped.
   */
  invalidate(url: string, config?: CorriereRequestConfig): void {
    const merged = mergeConfig(this.defaults, withRequestFields(config, { method: 'get', url }));
    void this.registry.cache.delete(cacheKeyFor(merged));
  }

  request<T = any>(
    configOrUrl: string | CorriereRequestConfig,
    config?: CorriereRequestConfig,
  ): Promise<CorriereResponse<T>> {
    if (typeof configOrUrl === 'string') {
      config = { ...config, url: configOrUrl };
    } else {
      config = configOrUrl ? { ...configOrUrl } : {};
    }

    const mergedConfig = mergeConfig(this.defaults, config);

    mergedConfig.method = (mergedConfig.method || 'get').toLowerCase();

    // Rejected rather than thrown: every other failure path in `request()` surfaces as a
    // rejected promise, so throwing here would escape `client.request(...).catch(handler)`.
    if (!mergedConfig.url && !mergedConfig.baseURL) {
      return Promise.reject(
        new CorriereError(
          'Request URL is required. Provide a `url` or `baseURL` in the config.',
          CorriereError.ERR_BAD_OPTION,
          mergedConfig,
          null,
          null,
        ),
      );
    }

    const { requestInterceptors, responseInterceptors, synchronous } =
      this.collectInterceptors(mergedConfig);

    let promise: Promise<any>;

    if (synchronous) {
      try {
        const finalCfg = runRequestInterceptorsSync(mergedConfig, requestInterceptors);
        promise = dispatchAndRetry(finalCfg, this.registry);
      } catch (err) {
        promise = Promise.reject(err);
      }
    } else {
      promise = runRequestInterceptorsAsync(mergedConfig, requestInterceptors).then(
        (cfg: CorriereRequestConfig) => dispatchAndRetry(cfg, this.registry),
      );
    }

    promise = promise.then(
      (value: CorriereResponse) => {
        logResponse(value);
        return value;
      },
      (error: any) => {
        // A CorriereError carries the config the request was actually sent with — after
        // request interceptors — which is what `logRequest` and `logResponse` see too.
        logError(error, error?.isCorriereError ? (error.config ?? mergedConfig) : mergedConfig);
        throw error;
      },
    );

    if (responseInterceptors.length > 0) {
      promise = promise.then(
        (value: CorriereResponse) => runResponseInterceptors(value, false, responseInterceptors),
        (error: any) => runResponseInterceptors(error, true, responseInterceptors),
      );
    }

    return promise;
  }

  private collectInterceptors(mergedConfig: CorriereRequestConfig): {
    requestInterceptors: InterceptorHandler[];
    responseInterceptors: InterceptorHandler[];
    synchronous: boolean;
  } {
    const requestInterceptors: InterceptorHandler[] = [];
    const responseInterceptors: InterceptorHandler[] = [];
    let synchronous = true;

    this.interceptors.request.forEach((interceptor: InterceptorHandler) => {
      if (interceptor.runWhen && !interceptor.runWhen(mergedConfig)) return;
      synchronous = synchronous && interceptor.synchronous;
      requestInterceptors.unshift(interceptor);
    });

    this.interceptors.response.forEach((interceptor: InterceptorHandler) => {
      responseInterceptors.push(interceptor);
    });

    return { requestInterceptors, responseInterceptors, synchronous };
  }

  getUri(config?: CorriereRequestConfig): string {
    return resolveURL(mergeConfig(this.defaults, config));
  }

  get<T = any>(url: string, config?: CorriereRequestConfig): Promise<CorriereResponse<T>> {
    return this.request<T>(withRequestFields(config, { method: 'get', url }));
  }

  delete<T = any>(url: string, config?: CorriereRequestConfig): Promise<CorriereResponse<T>> {
    return this.request<T>(withRequestFields(config, { method: 'delete', url }));
  }

  head<T = any>(url: string, config?: CorriereRequestConfig): Promise<CorriereResponse<T>> {
    return this.request<T>(withRequestFields(config, { method: 'head', url }));
  }

  options<T = any>(url: string, config?: CorriereRequestConfig): Promise<CorriereResponse<T>> {
    return this.request<T>(withRequestFields(config, { method: 'options', url }));
  }

  post<T = any>(
    url: string,
    data?: any,
    config?: CorriereRequestConfig,
  ): Promise<CorriereResponse<T>> {
    return this.request<T>(withRequestFields(config, { method: 'post', url, data }));
  }

  put<T = any>(
    url: string,
    data?: any,
    config?: CorriereRequestConfig,
  ): Promise<CorriereResponse<T>> {
    return this.request<T>(withRequestFields(config, { method: 'put', url, data }));
  }

  patch<T = any>(
    url: string,
    data?: any,
    config?: CorriereRequestConfig,
  ): Promise<CorriereResponse<T>> {
    return this.request<T>(withRequestFields(config, { method: 'patch', url, data }));
  }

  private formRequest<T = any>(
    method: 'post' | 'put' | 'patch',
    url: string,
    data?: any,
    config?: CorriereRequestConfig,
  ): Promise<CorriereResponse<T>> {
    const useBrackets =
      config?.formSerializer?.brackets ?? this.defaults.formSerializer?.brackets ?? false;
    const formData =
      data && !(data instanceof FormData)
        ? toFormData(data, undefined, undefined, undefined, { brackets: useBrackets })
        : data;
    const merged = withRequestFields(config, { method, url, data: formData });
    merged.headers = mergeConfig(
      { headers: config?.headers },
      {
        headers: { 'Content-Type': 'multipart/form-data' },
      },
    ).headers;
    return this.request<T>(merged);
  }

  postForm<T = any>(
    url: string,
    data?: any,
    config?: CorriereRequestConfig,
  ): Promise<CorriereResponse<T>> {
    return this.formRequest<T>('post', url, data, config);
  }

  putForm<T = any>(
    url: string,
    data?: any,
    config?: CorriereRequestConfig,
  ): Promise<CorriereResponse<T>> {
    return this.formRequest<T>('put', url, data, config);
  }

  patchForm<T = any>(
    url: string,
    data?: any,
    config?: CorriereRequestConfig,
  ): Promise<CorriereResponse<T>> {
    return this.formRequest<T>('patch', url, data, config);
  }

  async *stream<T = any>(
    url: string,
    config?: CorriereRequestConfig,
  ): AsyncGenerator<T, void, unknown> {
    const merged = withRequestFields(config, { method: 'get', url });
    merged.responseType = 'stream';
    const response = await this.request<any>(merged);
    yield* readStreamBody<T>(response);
  }

  autoPaginate<T = any>(
    url: string,
    config?: CorriereRequestConfig,
  ): AsyncGenerator<T, void, unknown> {
    return paginate<T>(this, url, config);
  }

  gql<T = any>(
    url: string,
    query: string,
    variables?: Record<string, any>,
    config?: CorriereRequestConfig,
  ): Promise<CorriereResponse<T>> {
    return this.post<T>(url, { query, variables }, config);
  }
}

export default Corriere;
