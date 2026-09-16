import buildURL from './core/buildURL';
import CorriereError from './core/corriereError';
import { CREDENTIAL_HEADERS } from './core/fetchAdapter';
import mergeConfig from './core/mergeConfig';
import dispatchRequest, { cacheKeyFor, createRegistry, type RequestRegistry } from './core/request';
import retryRequest from './core/retry';
import defaultsConfig from './defaults/index';
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

function runRequestInterceptorsSync(
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
            throw new CorriereError(
              'Synchronous request interceptors cannot return a Promise.',
              CorriereError.ERR_BAD_OPTION,
              startConfig,
              null,
              null,
            );
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
          throw new CorriereError(
            'Synchronous request interceptors cannot return a Promise.',
            CorriereError.ERR_BAD_OPTION,
            startConfig,
            null,
            null,
          );
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

function runRequestInterceptorsAsync(
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

function originOf(absoluteURL: string): string | null {
  try {
    return new URL(absoluteURL).origin;
  } catch {
    return null;
  }
}

/**
 * Removes credentials from a config about to be sent to a different origin.
 *
 * `autoPaginate` follows a `next` link chosen by the server. That is the same trust
 * situation as a redirect hop, so it gets the same treatment the redirect follower already
 * applies: `Authorization`, `Cookie` and `Proxy-Authorization` are dropped, along with
 * `auth`, which would otherwise regenerate the `Authorization` header downstream.
 *
 * Copies rather than mutates, since the caller's config object is theirs.
 */
function withoutCredentials(config: CorriereRequestConfig): CorriereRequestConfig {
  const stripped: CorriereRequestConfig = { ...config, auth: undefined };
  if (!stripped.headers || typeof stripped.headers !== 'object') return stripped;

  const isCredential = (key: string) => CREDENTIAL_HEADERS.includes(key.toLowerCase());
  const headers: Record<string, unknown> = { ...(stripped.headers as Record<string, unknown>) };

  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (isCredential(key)) {
      delete headers[key];
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Method-group form (`{ common: {…}, get: {…} }`) nests exactly one level.
      const group: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      for (const inner of Object.keys(group)) {
        if (isCredential(inner)) delete group[inner];
      }
      headers[key] = group;
    }
  }

  stripped.headers = headers as CorriereRequestConfig['headers'];
  return stripped;
}

function assertPaginateHostAllowed(
  nextURL: string,
  nextOrigin: string,
  config: CorriereRequestConfig,
): void {
  if (config.allowedPaginateHosts === null) return;
  const allowed = config.allowedPaginateHosts ?? [];
  const host = originOf(nextURL) === nextOrigin ? new URL(nextURL).host : '';
  if (allowed.includes(host)) return;

  throw new CorriereError(
    `Pagination refused to follow a cross-origin next link to "${nextOrigin}". ` +
      'The link is chosen by the server being paginated, so following it would send your ' +
      'request there. Add the host to config.allowedPaginateHosts to permit it (credentials ' +
      'are dropped either way), or set allowedPaginateHosts to null to disable this check.',
    CorriereError.ERR_BAD_OPTION,
    config,
    null,
    null,
  );
}

function dispatchAndRetry(
  cfg: CorriereRequestConfig,
  registry: RequestRegistry,
): Promise<CorriereResponse> {
  const fullUrl = buildURL(cfg.url ?? '', cfg.baseURL, cfg.params, cfg.paramsSerializer);
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
  ];

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
        logError(error, mergedConfig);
        throw error;
      },
    );

    if (responseInterceptors.length > 0) {
      promise = promise.then(
        (value: CorriereResponse) =>
          this.runResponseInterceptors(value, false, responseInterceptors),
        (error: any) => this.runResponseInterceptors(error, true, responseInterceptors),
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

  private async runResponseInterceptors(
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

  getUri(config?: CorriereRequestConfig): string {
    const merged = mergeConfig(this.defaults, config);
    return buildURL(merged.url ?? '', merged.baseURL, merged.params, merged.paramsSerializer);
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
    const useBrackets = config?.formSerializer?.brackets ?? false;
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
    if (!response.data) return;

    const stream = response.data;
    const decoder = new TextDecoder();
    let buffer = '';

    const processLine = function* (line: string) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) {
        const dataStr = trimmed.replace(/^data:\s*/, '');
        if (dataStr === '[DONE]') return;
        try {
          yield JSON.parse(dataStr);
        } catch (_e) {
          yield dataStr as any;
        }
      } else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          yield JSON.parse(trimmed);
        } catch (_e) {
          yield trimmed;
        }
      } else if (trimmed) {
        yield trimmed;
      }
    };

    const handleChunk = function* (chunk: any) {
      const chunkStr =
        chunk instanceof Uint8Array || ArrayBuffer.isView(chunk) || chunk instanceof ArrayBuffer
          ? decoder.decode(chunk as any, { stream: true })
          : String(chunk);
      buffer += chunkStr;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        yield* processLine(line);
      }
    };

    if (typeof stream.getReader === 'function') {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield* handleChunk(value);
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          // ignore errors on cancel
        }
        reader.releaseLock();
      }
    } else if (typeof stream[Symbol.asyncIterator] === 'function') {
      try {
        for await (const chunk of stream) {
          yield* handleChunk(chunk);
        }
      } finally {
        if (typeof stream.destroy === 'function') {
          try {
            stream.destroy();
          } catch {
            // ignore
          }
        }
      }
    } else {
      throw new Error('[Corriere] The response data is not a readable stream or async iterable.');
    }

    buffer += decoder.decode(new Uint8Array(), { stream: false });
    if (buffer.trim()) {
      yield* processLine(buffer);
    }
  }

  async *autoPaginate<T = any>(
    url: string,
    config?: CorriereRequestConfig,
  ): AsyncGenerator<T, void, unknown> {
    let nextUrl: string | null = url;
    let currentConfig = config || {};

    // An API that returns a `next` link pointing at the current (or an earlier) page would
    // otherwise spin forever. Both guards are needed: `visited` catches tight cycles
    // immediately, `maxPages` bounds chains that never repeat a URL but never end either.
    const maxPages = config?.maxPages ?? 1000;
    const visited = new Set<string>();
    let pageCount = 0;

    // Cycle detection compares a normalized (absolute) form of each URL, so an API that
    // alternates between relative and absolute forms of the same page is still caught —
    // not just a byte-for-byte repeat.
    const normalizeForCycleCheck = (raw: string): string => {
      try {
        return new URL(
          raw,
          currentConfig.baseURL || this.defaults.baseURL || 'http://dummy-base.invalid',
        ).href;
      } catch {
        return raw;
      }
    };

    // Every later page is judged against where pagination started, not against the previous
    // hop — otherwise a chain of same-looking single steps could walk anywhere.
    const initialOrigin = originOf(normalizeForCycleCheck(url));

    while (nextUrl) {
      const cycleKey = normalizeForCycleCheck(nextUrl);
      if (visited.has(cycleKey)) {
        throw new CorriereError(
          `Pagination cycle detected: ${nextUrl} was already requested. ` +
            'Check the `next` link returned by the API.',
          CorriereError.ERR_BAD_RESPONSE,
          currentConfig,
          null,
          null,
        );
      }
      visited.add(cycleKey);

      if (++pageCount > maxPages) {
        throw new CorriereError(
          `Pagination exceeded maxPages (${maxPages}). Raise config.maxPages if this is expected.`,
          CorriereError.ERR_BAD_RESPONSE,
          currentConfig,
          null,
          null,
        );
      }

      const response: CorriereResponse<any> = await this.get(nextUrl, currentConfig);

      const data = response.data;
      let items: any = null;

      if (currentConfig.paginateItems) {
        if (typeof currentConfig.paginateItems === 'function') {
          items = currentConfig.paginateItems(data);
        } else if (
          typeof currentConfig.paginateItems === 'string' &&
          data &&
          typeof data === 'object'
        ) {
          items = (data as any)[currentConfig.paginateItems];
        }
      } else {
        items = Array.isArray(data)
          ? data
          : data && typeof data === 'object'
            ? (data as any).data || (data as any).items || (data as any).results || null
            : null;
      }

      if (Array.isArray(items)) {
        for (const item of items) {
          yield item;
        }
      }

      nextUrl =
        data && typeof data === 'object'
          ? (data as any).next || (data as any).links?.next || null
          : null;

      if (nextUrl) {
        let merged: CorriereRequestConfig = { ...currentConfig, url: nextUrl };
        if (merged.params) {
          merged.params = { ...merged.params };
          try {
            const dummyBase = 'http://dummy-base.com';
            const parsedUrl = new URL(nextUrl, dummyBase);
            for (const key of parsedUrl.searchParams.keys()) {
              delete merged.params[key];
            }
          } catch {
            merged.params = {};
          }
        }

        // The `next` link is server-controlled. Left unchecked it can walk the client — and
        // whatever credentials the config carries — onto an arbitrary host.
        const nextOrigin = originOf(normalizeForCycleCheck(nextUrl));
        if (nextOrigin && initialOrigin && nextOrigin !== initialOrigin) {
          assertPaginateHostAllowed(normalizeForCycleCheck(nextUrl), nextOrigin, currentConfig);
          merged = withoutCredentials(merged);
        }

        currentConfig = merged;
      }
    }
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
