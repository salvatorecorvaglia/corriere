import type buildURL from './core/buildURL';
import type { CorriereError } from './core/corriereError';
import type mergeConfig from './core/mergeConfig';
import type Corriere from './corriere';
import type { MemoryCache } from './helpers/memoryCache';
import type { createRateLimiter } from './helpers/rateLimiter';
import type InterceptorManager from './interceptors/interceptorManager';

/**
 * The error type is the `CorriereError` class itself. It used to be a separate, hand-kept
 * interface here that could drift from the class it described.
 */
export type { CorriereError };

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

/**
 * A registered interceptor. `V` is the value it receives; `R` is what it may hand on —
 * the same type for request interceptors, anything for response interceptors.
 */
export interface InterceptorHandler<V = any, R = V> {
  fulfilled: ((value: V) => R | Promise<R>) | null;
  rejected: ((error: any) => unknown) | null;
  synchronous: boolean;
  runWhen: RunWhenFunction | null;
}

/**
 * Request interceptors receive the config and must return one (or a promise of one).
 * Response interceptors receive the response and may return anything: whatever they return
 * is what the call resolves with, so one can unwrap `response.data`, for example.
 */
export interface Interceptors {
  request: InterceptorManager<CorriereRequestConfig>;
  response: InterceptorManager<CorriereResponse, unknown>;
}

/**
 * One Server-Sent Event, as `stream()` yields it with `sseEvents: true`.
 */
export interface ServerSentEvent<T = unknown> {
  /** The `event:` field, or `'message'` when the event had none. */
  event: string;
  /** The event's data, parsed as JSON when it parses, text otherwise. */
  data: T;
  /** The last event ID the stream set with `id:`, if any. It carries over between events. */
  id?: string;
  /** A `retry:` reconnection time in milliseconds, on the first event after it was sent. */
  retry?: number;
}

export type HeaderValue = string | string[];

/** A flat set of headers: name → value. */
export type RawHeaders = Record<string, HeaderValue>;

/**
 * Request headers. Flat headers and per-method groups can be mixed in one object:
 * `common` applies to every request, a method group (`get`, `post`, …) to that method, and
 * any other key is a header sent on every request. A header set to `undefined` is omitted.
 */
export interface CorriereHeaders {
  common?: RawHeaders;
  get?: RawHeaders;
  delete?: RawHeaders;
  head?: RawHeaders;
  options?: RawHeaders;
  post?: RawHeaders;
  put?: RawHeaders;
  patch?: RawHeaders;
  [header: string]: HeaderValue | RawHeaders | undefined;
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
  /**
   * Whether an absolute `url` may point outside `baseURL` (default `false`). By default
   * every request on a client with a `baseURL` stays under it: an absolute `url` on the
   * same origin and under the base path is sent as is, and any other is rejected with
   * `ERR_BAD_OPTION` instead of being sent to whatever host it names. Set `true` to let an
   * absolute `url` override `baseURL`. Has no effect without a `baseURL`.
   */
  allowAbsoluteUrls?: boolean;
  method?: Method | string;
  params?: Record<string, unknown>;
  paramsSerializer?: ParamsSerializer;
  data?: unknown;
  headers?: CorriereHeaders;
  auth?: AuthConfig;
  timeout?: number;
  withCredentials?: boolean;
  responseType?: ResponseType;
  transformRequest?: TransformFunction | TransformFunction[];
  transformResponse?: TransformFunction | TransformFunction[];
  validateStatus?: ((status: number) => boolean) | null;
  retry?: number;
  /**
   * Methods that may be retried after a network error, timeout or 5xx — failures where the
   * server may already have acted on the request. Case-insensitive. Defaults to the
   * idempotent methods, `DEFAULT_RETRY_METHODS` (`get`, `head`, `options`, `put`,
   * `delete`), so a `POST` or `PATCH` is never sent twice unless you list it. A `429` is
   * retried for any method, since the server did not process the request.
   */
  retryMethods?: readonly string[];
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
  /**
   * For `stream()` on a `text/event-stream` response: yield each event as a
   * `ServerSentEvent` — `{ event, data, id?, retry? }` — instead of just its data. Has no
   * effect on any other content type.
   */
  sseEvents?: boolean;
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
  /**
   * Set by `autoPaginate` once pagination has followed a `next` link off the starting
   * origin. Enforced where the final headers are built — after the instance defaults are
   * merged in and after request interceptors have run — so no credential can be
   * re-attached downstream of the point that decided to drop it.
   */
  _stripCredentials?: boolean;
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

export interface RateLimiter {
  acquire: (signal?: AbortSignal) => Promise<void>;
  release: () => void;
  destroy: () => void;
  pending: number;
  active: number;
  destroyed: boolean;
}

/** The client methods an instance exposes, kept in step with `Corriere.publicMethods`. */
export type CorriereMethods = Pick<Corriere, (typeof Corriere.publicMethods)[number]>;

/**
 * What `corriere.create()` returns: a callable client — `client(config)` or
 * `client(url, config)` — carrying every client method plus the static helpers.
 */
export interface CorriereInstance extends CorriereMethods {
  <T = any>(config: CorriereRequestConfig): Promise<CorriereResponse<T>>;
  <T = any>(url: string, config?: CorriereRequestConfig): Promise<CorriereResponse<T>>;

  defaults: CorriereRequestConfig;
  interceptors: Interceptors;

  all<T extends readonly unknown[] | []>(
    values: T,
  ): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }>;
  spread<T, R>(callback: (...args: T[]) => R): (array: T[]) => R;
  isCancel(value: unknown): value is CorriereError;
  isCorriereError(value: unknown): value is CorriereError;

  CorriereError: typeof CorriereError;
  Corriere: typeof Corriere;
  mergeConfig: typeof mergeConfig;
  buildURL: typeof buildURL;
  InterceptorManager: typeof InterceptorManager;
  createRateLimiter: typeof createRateLimiter;
  MemoryCache: typeof MemoryCache;
}

/** The default export: an instance that can also `create()` further instances. */
export interface CorriereStatic extends CorriereInstance {
  create(config?: CorriereRequestConfig): CorriereInstance;
}
