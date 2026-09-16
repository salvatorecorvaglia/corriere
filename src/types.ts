import type InterceptorManager from './interceptors/interceptorManager';

export type Method = 'get' | 'delete' | 'head' | 'options' | 'post' | 'put' | 'patch';

export type ResponseType = 'json' | 'text' | 'blob' | 'arraybuffer' | 'stream';

export interface AuthConfig {
  username: string;
  password: string;
}

export type ParamsSerializer = (params: Record<string, unknown>) => string;

export type TransformFunction = (
  data: unknown,
  headers: Record<string, string | string[]>,
  config?: any,
) => unknown | Promise<unknown>;

export type RetryConditionFunction = (error: CorriereError) => boolean;

export type OnRetryFunction = (
  attempt: number,
  error: CorriereError,
  config: CorriereRequestConfig,
) => void;

export type RunWhenFunction = (config: CorriereRequestConfig) => boolean;

export interface InterceptorOptions {
  synchronous?: boolean;
  runWhen?: RunWhenFunction;
}

export interface InterceptorHandler {
  fulfilled: TransformFunction | null;
  rejected: ((error: unknown) => unknown) | null;
  synchronous: boolean;
  runWhen: RunWhenFunction | null;
}

export interface Interceptors {
  request: InterceptorManager;
  response: InterceptorManager;
}

/**
 * Reported as a response body is read. `total` is the `content-length` the server sent, or
 * `0` when it sent none — it is never nullish, so compute a percentage only when it is
 * greater than zero.
 */
export interface DownloadProgressEvent {
  loaded: number;
  total: number;
}

export interface CorriereHooks {
  onBeforeRequest?: (config: CorriereRequestConfig) => void | Promise<void>;
  onRequestResponse?: (response: CorriereResponse) => void | Promise<void>;
  onRequestError?: (error: CorriereError) => void | Promise<void>;
}

export interface CacheProvider {
  get: (key: string) => Promise<any> | any;
  set: (key: string, value: any, ttl?: number) => Promise<void> | void;
  delete: (key: string) => Promise<void> | void;
  clear: () => Promise<void> | void;
}

export interface SchemaValidator<T = any> {
  parse(data: unknown): T;
  parseAsync?(data: unknown): Promise<T>;
}

export interface CorriereRequestConfig {
  url?: string;
  baseURL?: string;
  method?: Method | string;
  params?: Record<string, unknown>;
  paramsSerializer?: ParamsSerializer;
  data?: unknown;
  headers?: Record<string, string | string[]> | Record<string, Record<string, string | string[]>>;
  auth?: AuthConfig;
  timeout?: number;
  withCredentials?: boolean;
  responseType?: ResponseType;
  transformRequest?: TransformFunction | TransformFunction[];
  transformResponse?: TransformFunction | TransformFunction[];
  validateStatus?: ((status: number) => boolean) | null;
  retry?: number;
  retryDelay?: number;
  retryCondition?: RetryConditionFunction;
  onRetry?: OnRetryFunction;
  signal?: AbortSignal;
  debug?: boolean;
  rateLimiter?: RateLimiter;
  maxContentLength?: number;
  allowedProtocols?: string[] | null;
  /**
   * Maximum redirects to follow. When set, redirects are followed manually so every hop
   * is re-checked against `allowedProtocols` and credential headers are dropped on
   * cross-origin hops. `0` returns the 3xx response without following it. Leave unset to
   * let `fetch` follow redirects itself (intermediate hops are then not re-validated).
   * Not supported in browsers, which return opaque redirect responses.
   */
  maxRedirects?: number;
  dispatcher?: unknown;
  agent?: unknown;
  dedupe?: boolean;
  cache?: boolean | CacheProvider;
  cacheTTL?: number;
  cacheKeySerializer?: (
    config: CorriereRequestConfig,
    fullURL: string,
    headers: Record<string, string | string[]>,
  ) => string;
  onDownloadProgress?: (progressEvent: DownloadProgressEvent) => void;
  hooks?: CorriereHooks;
  schema?: SchemaValidator;
  fetch?: typeof fetch;
  retryOn429?: boolean;
  maxRetryDelay?: number;
  formSerializer?: { brackets?: boolean };
  cacheClone?: boolean;
  paginateItems?: string | ((data: any) => any[]);
  /**
   * Upper bound on pages fetched by `autoPaginate` (default 1000). Guards against an API
   * whose `next` link never terminates; a repeated URL is rejected immediately regardless.
   */
  maxPages?: number;
  /**
   * Extra hosts an `autoPaginate` `next` link may point to, beyond the origin of the first
   * page. A `next` link is chosen by the server, so by default one that crosses origins is
   * rejected rather than followed with your credentials attached.
   *
   * Listing a host permits the hop but still drops `Authorization`, `Cookie`,
   * `Proxy-Authorization` and `auth` for it, exactly as a cross-origin redirect does. Set
   * to `null` to disable the host check entirely (credentials are still dropped), mirroring
   * `allowedProtocols`.
   */
  allowedPaginateHosts?: string[] | null;
}

/**
 * Fields Corriere attaches to a config as it moves through the pipeline.
 *
 * Kept off `CorriereRequestConfig` so they do not appear in consumers' autocomplete or
 * read as things a caller is expected to set — `_builtUrl` in particular is just the
 * memoised result of `buildURL`, and a caller supplying their own would silently override
 * `url`, `baseURL` and `params` all at once.
 */
export type InternalConfig = CorriereRequestConfig & {
  _builtUrl?: string;
};

export interface CorriereResponse<T = unknown> {
  data: T;
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  config: CorriereRequestConfig;
  request: Response;
  duration: number;
}

export interface CorriereError extends Error {
  name: 'CorriereError';
  code: string | null;
  config: CorriereRequestConfig | null;
  request: unknown;
  response: CorriereResponse | null;
  isCorriereError: true;
  cause?: Error;
  toJSON(): Record<string, unknown>;
}

export interface RateLimiter {
  acquire: (signal?: AbortSignal) => Promise<void>;
  release: () => void;
  destroy: () => void;
  pending: number;
  active: number;
  destroyed: boolean;
}
