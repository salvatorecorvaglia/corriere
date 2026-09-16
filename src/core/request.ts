import { setBasicAuth } from '../helpers/auth';
import { buildFetchHeaders, flattenHeaders, removeContentType } from '../helpers/flattenHeaders';
import { MemoryCache } from '../helpers/memoryCache';
import settle from '../helpers/settle';
import transformData from '../helpers/transformData';
import type {
  CacheProvider,
  CorriereRequestConfig,
  CorriereResponse,
  InternalConfig,
  TransformFunction,
} from '../types';
import buildURL from './buildURL';
import CorriereError, { FROM_CACHE } from './corriereError';
import fetchAdapter from './fetchAdapter';
import { assertAllowedProtocol } from './protocol';

type HeadersConfig = Record<string, Record<string, string | string[]>>;
type FlatHeaders = Record<string, string | string[]>;

/**
 * Non-cryptographic digest of the header segment of a cache key.
 *
 * Header values include `Authorization` (and Basic-auth credentials, since `setBasicAuth`
 * runs before the key is built), so embedding them verbatim handed a live bearer token to
 * every `CacheProvider` — a Redis- or disk-backed one would persist it in plaintext. The
 * headers still have to *distinguish* entries, they just must not be readable, so this
 * hashes rather than drops them.
 *
 * A collision here mixes up two cache entries; it cannot bypass authentication, because
 * the key is never what grants access. That makes a fast 64-bit FNV-1a (two lanes, seeded
 * and rotated differently so they do not move in lockstep) the right trade rather than a
 * real digest, which would pull in a crypto dependency this library does not have.
 */
function hashHeaders(serialized: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xc9dc5118;
  for (let i = 0; i < serialized.length; i++) {
    const c = serialized.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193);
    h2 = (h2 << 5) | (h2 >>> 27);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

function buildCacheKey(
  config: CorriereRequestConfig,
  fullURL: string,
  flatHeaders: FlatHeaders,
): string {
  if (typeof config.cacheKeySerializer === 'function') {
    return config.cacheKeySerializer(config, fullURL, flatHeaders);
  }
  const method = (config.method || 'GET').toUpperCase();
  const withCreds = config.withCredentials ? '1' : '0';
  const respType = config.responseType || 'json';

  // Sort and serialize headers dynamically to prevent collisions,
  // excluding environment-specific transient headers.
  const serializedHeaders = Object.keys(flatHeaders)
    .sort()
    .filter(
      (k) =>
        !['user-agent', 'connection', 'host', 'content-length', 'accept-encoding'].includes(
          k.toLowerCase(),
        ),
    )
    .map((k) => {
      const val = flatHeaders[k];
      return `${k.toLowerCase()}=${Array.isArray(val) ? val.join(',') : val}`;
    })
    .join('&');

  return `${method}:${fullURL}|h:${hashHeaders(serializedHeaders)}|c=${withCreds}|t=${respType}`;
}

/**
 * The cache key for a config, computed exactly as `dispatchRequest` computes it.
 *
 * Exported so `Corriere.invalidate()` can drop an entry without callers ever having to
 * know the key format — and so the two can never disagree about it.
 */
export function cacheKeyFor(config: CorriereRequestConfig): string {
  const fullURL =
    (config as InternalConfig)._builtUrl ||
    buildURL(config.url ?? '', config.baseURL, config.params, config.paramsSerializer);
  const flatHeaders = flattenHeaders(config.headers as HeadersConfig | undefined, config.method);
  setBasicAuth(config, flatHeaders);
  return buildCacheKey(config, fullURL, flatHeaders);
}

/**
 * Dedupe collapses two calls into one *in-flight request*, so it must additionally
 * separate configs that would behave differently on the wire even though they would cache
 * identically. `timeout` is the one such field not already covered: a cached body does not
 * depend on it, so it is deliberately not part of the cache key.
 */
function buildDedupeKey(config: CorriereRequestConfig, cacheKey: string): string {
  return `${cacheKey}|to=${config.timeout ?? 0}`;
}

/**
 * Entries used to live forever unless evicted, so `cache: true` without an explicit
 * `cacheTTL` was an unbounded staleness window rather than a cache. Five minutes is the
 * conventional default; `cacheTTL: 0` now means "do not cache this call".
 */
export const DEFAULT_CACHE_TTL = 300_000;

function buildTransformArray(
  transform: TransformFunction | TransformFunction[] | undefined,
): TransformFunction[] {
  if (!transform) return [];
  if (Array.isArray(transform)) return transform;
  return [transform];
}

function resolveCacheProvider(
  cache: CorriereRequestConfig['cache'],
  registry: RequestRegistry,
): CacheProvider {
  return typeof cache === 'object' ? cache : registry.cache;
}

function settleResponse(
  response: CorriereResponse,
  config: CorriereRequestConfig,
): Promise<CorriereResponse> {
  return new Promise<CorriereResponse>((resolve, reject) => {
    settle(
      resolve as (value: CorriereResponse) => void,
      reject as (reason: CorriereError) => void,
      response,
      config,
    );
  });
}

/**
 * Runs `config.schema` against a settled response's data, in place.
 *
 * Shared by the live-fetch path (validating freshly transformed data) and the cache-hit
 * path (validating a replayed response) so a caller that supplies a stricter `schema` than
 * the call that originally populated the cache still gets it enforced, instead of silently
 * receiving unvalidated cached data.
 */
async function applySchema(
  settled: CorriereResponse,
  config: CorriereRequestConfig,
): Promise<CorriereResponse> {
  if (!config.schema) return settled;
  try {
    settled.data =
      typeof config.schema.parseAsync === 'function'
        ? await config.schema.parseAsync(settled.data)
        : config.schema.parse(settled.data);
    return settled;
  } catch (schemaError) {
    throw CorriereError.from(
      schemaError instanceof Error ? schemaError : new Error(String(schemaError)),
      CorriereError.ERR_BAD_RESPONSE,
      config,
      settled.request,
      settled,
    );
  }
}

/**
 * Turns a raw adapter response into the value handed back to one caller: applies
 * `transformResponse`, enforces `validateStatus`, and stores the result if caching is on.
 *
 * The cache write is bracketed on both sides for a reason.
 *
 * It happens *after* settling because storing first meant a 4xx/5xx was written to the
 * cache and then replayed to later callers as a resolved success, silently bypassing
 * `validateStatus`.
 *
 * It happens *before* `applySchema` because `applySchema` mutates `settled.data` in place.
 * A schema that transforms its input (a Zod `.transform()`, say) would otherwise write its
 * transformed output into a cache shared with callers who passed no schema at all, and
 * they would receive a shape they never asked for. Caching the pre-schema value keeps the
 * cache a record of what the server sent; every reader re-applies its own schema on the
 * way out (see the cache-hit path in `dispatchRequest`).
 *
 * `cloneRaw` is set only for the dedupe fan-out, where a single adapter response is shared
 * by several callers and each needs an independent copy. A single-consumer response is its
 * caller's alone, so cloning it would be pure overhead.
 *
 * `writeCache` is false for every dedupe subscriber but the first: they all share one
 * cache key, so N writes would be redundant and which one won would depend on how long
 * each caller's hooks took.
 */
async function finalizeAndSettle(
  raw: CorriereResponse,
  config: CorriereRequestConfig,
  options: {
    isGet: boolean;
    cacheKey: string;
    cloneRaw: boolean;
    writeCache: boolean;
    registry: RequestRegistry;
  },
): Promise<CorriereResponse> {
  const source = options.cloneRaw && config.cacheClone !== false ? cloneResponse(raw) : raw;
  const response = finalizeResponse(source, config);

  response.data = await transformData(
    buildTransformArray(config.transformResponse),
    response.data,
    response.headers,
    config,
    'response',
  );

  const settled = await settleResponse(response, config);

  const ttl = config.cacheTTL ?? DEFAULT_CACHE_TTL;
  if (options.writeCache && options.isGet && config.cache && ttl > 0) {
    await resolveCacheProvider(config.cache, options.registry).set(
      options.cacheKey,
      config.cacheClone !== false ? cloneResponse(settled) : settled,
      ttl,
    );
  }

  // Schema validation runs on the transformed data of an accepted response: validating the
  // raw adapter output meant schemas saw pre-transform values (often still a string), and
  // a failing status surfaced as a schema error rather than the status error.
  await applySchema(settled, config);

  return settled;
}

/**
 * Runs a caller's `onRequestError` hook without letting its own failure escape.
 *
 * Every call site needs the same guarantee — a broken hook must not mask the request
 * error, stall delivery to the other dedupe subscribers, or surface as an unhandled
 * rejection — and the guard has to cover a hook that throws *synchronously* as well as one
 * that returns a rejected promise. Keeping it in one place is what stops the four call
 * sites from drifting apart again.
 */
async function safeInvokeErrorHook(config: CorriereRequestConfig, error: unknown): Promise<void> {
  if (!config.hooks?.onRequestError || !(error instanceof CorriereError)) return;
  try {
    await config.hooks.onRequestError(error);
  } catch {
    // Intentionally swallowed; see above.
  }
}

async function executeFetchRequest(
  config: CorriereRequestConfig,
  fullURL: string,
  flatHeaders: FlatHeaders,
): Promise<CorriereResponse> {
  const requestTransforms = buildTransformArray(config.transformRequest);
  const requestData = await transformData(requestTransforms, config.data, flatHeaders, config);

  if (
    requestData === null ||
    requestData === undefined ||
    (typeof FormData !== 'undefined' && requestData instanceof FormData)
  ) {
    removeContentType(flatHeaders);
  }

  const fetchOptions: RequestInit = {
    method: (config.method || 'GET').toUpperCase(),
    headers: buildFetchHeaders(flatHeaders),
  };

  const methodsWithBody = ['POST', 'PUT', 'PATCH', 'DELETE'];
  if (
    methodsWithBody.includes(fetchOptions.method!) &&
    requestData !== undefined &&
    requestData !== null
  ) {
    fetchOptions.body = requestData as BodyInit;
  }

  if (config.withCredentials) {
    fetchOptions.credentials = 'include';
  }

  if (config.dispatcher) {
    (fetchOptions as any).dispatcher = config.dispatcher;
  }
  if (config.agent) {
    (fetchOptions as any).agent = config.agent;
  }

  const requestStartTime = Date.now();
  return await fetchAdapter(config, fullURL, fetchOptions, requestStartTime);
}

interface Subscriber {
  config: CorriereRequestConfig;
  resolve: (res: CorriereResponse) => void;
  reject: (err: any) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface InFlightRecord {
  promise: Promise<CorriereResponse>;
  abortController: AbortController;
  subscribers: Set<Subscriber>;
}

/** Releases a subscriber's abort listener once its outcome is decided. */
function detachSubscriber(sub: Subscriber): void {
  if (sub.signal && sub.onAbort) {
    sub.signal.removeEventListener('abort', sub.onAbort);
  }
}

/**
 * Re-homes a shared error onto one subscriber's own config, so each caller's error carries
 * the config it actually passed rather than the config of whoever won the dedupe race.
 */
function asSubscriberError(error: unknown, config: CorriereRequestConfig): unknown {
  if (!(error instanceof CorriereError)) return error;
  return CorriereError.from(
    error,
    error.code || 'ERR_DEDUPE',
    config,
    error.request,
    error.response,
  );
}

/**
 * The dedupe and cache state one client owns.
 *
 * Both used to be module globals, so every instance `create()` produced shared them. Two
 * clients configured with different transports (`config.fetch`, `dispatcher`, `agent`) but
 * the same URL collapsed into a single request and each could receive the other's
 * response — none of those fields are, or reasonably could be, part of a cache key. Owning
 * the registry is what makes the separation structural instead of a matter of hashing
 * enough fields. It also makes tests isolable, which the shared map actively prevented.
 */
export interface RequestRegistry {
  inflight: Map<string, InFlightRecord>;
  cache: CacheProvider;
}

export function createRegistry(): RequestRegistry {
  return { inflight: new Map<string, InFlightRecord>(), cache: new MemoryCache() };
}

/**
 * Used when `dispatchRequest` is called as a free function rather than through a client —
 * which the test suite does extensively, and which stays supported.
 */
const defaultRegistry = createRegistry();

export function __activeRequestsSize(registry: RequestRegistry = defaultRegistry): number {
  return registry.inflight.size;
}

/**
 * Ceiling on tracked in-flight requests.
 *
 * Entries are normally removed the moment their request settles, so this only ever binds
 * when requests hang and never settle at all. It bounds the *map* — the records themselves
 * stay reachable from their own pending promise callbacks, so a hung request leaks with or
 * without this. Evicting also costs dedupe: a later identical call no longer finds the
 * entry and starts a second request. Both are the right trade against unbounded growth.
 */
const MAX_ACTIVE_REQUESTS = 1024;

function trackActiveRequest(registry: RequestRegistry, key: string, record: InFlightRecord): void {
  registry.inflight.set(key, record);
  while (registry.inflight.size > MAX_ACTIVE_REQUESTS) {
    const oldest = registry.inflight.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    registry.inflight.delete(oldest);
  }
}

function createCanceledError(config: CorriereRequestConfig): CorriereError {
  const reason = config.signal?.reason;
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : 'Request aborted';
  const err = new CorriereError(message, CorriereError.ERR_CANCELED, config, null, null);
  if (reason instanceof Error) {
    err.cause = reason;
  }
  return err;
}

export default async function dispatchRequest(
  config: CorriereRequestConfig,
  registry: RequestRegistry = defaultRegistry,
): Promise<CorriereResponse> {
  const fullURL =
    (config as InternalConfig)._builtUrl ||
    buildURL(
      config.url ?? '',
      config.baseURL,
      config.params as Record<string, unknown> | undefined,
      config.paramsSerializer,
    );

  assertAllowedProtocol(fullURL, config);

  if (config.hooks?.onBeforeRequest) {
    await config.hooks.onBeforeRequest(config);
  }

  const flatHeaders = flattenHeaders(config.headers as HeadersConfig | undefined, config.method);
  setBasicAuth(config, flatHeaders);

  const isGet = (config.method || 'GET').toUpperCase() === 'GET';
  const cacheKey =
    isGet && (config.cache || config.dedupe) ? buildCacheKey(config, fullURL, flatHeaders) : '';
  const dedupeKey = cacheKey && buildDedupeKey(config, cacheKey);

  if (isGet && config.cache) {
    const cached = await resolveCacheProvider(config.cache, registry).get(cacheKey);
    if (cached) {
      const clonedCached = config.cacheClone !== false ? cloneResponse(cached) : cached;
      const cachedView: CorriereResponse = {
        ...clonedCached,
        config,
      };
      try {
        // Replayed responses go through validateStatus too, so a caller that tightened
        // validateStatus is not handed a status it would have rejected on a live request.
        const settled = await settleResponse(cachedView, config);
        // A caller can supply a stricter `schema` than the one active when the cache
        // was populated, so it's re-applied on every cache hit, not just at write time.
        await applySchema(settled, config);
        if (config.hooks?.onRequestResponse) {
          await config.hooks.onRequestResponse(settled);
        }
        return settled;
      } catch (error) {
        // Tells `retryRequest` not to bother: the value came from the cache, so every
        // further attempt would read the same entry back and fail the same way.
        if (error instanceof CorriereError) {
          (error as unknown as Record<symbol, boolean>)[FROM_CACHE] = true;
        }
        await safeInvokeErrorHook(config, error);
        throw error;
      }
    }
  }

  if (isGet && config.dedupe) {
    let record = registry.inflight.get(dedupeKey);
    const isNew = !record;
    if (isNew) {
      const recordAbortController = new AbortController();
      const fetchConfig = { ...config, signal: recordAbortController.signal };

      const promise = executeFetchRequest(fetchConfig, fullURL, flatHeaders);

      record = {
        promise,
        abortController: recordAbortController,
        subscribers: new Set<Subscriber>(),
      };

      trackActiveRequest(registry, dedupeKey, record);

      // Both branches deliver with `Promise.allSettled` over a snapshot of the subscriber
      // set. Snapshot because an aborting subscriber removes itself mid-iteration;
      // `allSettled` because delivery is per-subscriber work — a slow (or broken)
      // `onRequestResponse` on one caller must not hold up everybody behind it, and
      // nothing here is allowed to reject the outer promise, which has no handler.
      promise.then(
        async (shared) => {
          if (registry.inflight.get(dedupeKey) === record) {
            registry.inflight.delete(dedupeKey);
          }
          const subs = [...record!.subscribers];
          await Promise.allSettled(
            subs.map(async (sub, index) => {
              detachSubscriber(sub);
              try {
                const settled = await finalizeAndSettle(shared, sub.config, {
                  isGet,
                  cacheKey,
                  registry,
                  cloneRaw: true,
                  // Every subscriber shares one cache key, so only the caller that
                  // started the request writes it. Otherwise the entry that survived
                  // would be whichever caller's hooks happened to finish last.
                  writeCache: index === 0,
                });

                if (sub.config.hooks?.onRequestResponse) {
                  await sub.config.hooks.onRequestResponse(settled);
                }

                sub.resolve(settled);
              } catch (subErr) {
                const finalError = asSubscriberError(subErr, sub.config);
                await safeInvokeErrorHook(sub.config, finalError);
                sub.reject(finalError);
              }
            }),
          );
        },
        async (error) => {
          if (registry.inflight.get(dedupeKey) === record) {
            registry.inflight.delete(dedupeKey);
          }
          const subs = [...record!.subscribers];
          await Promise.allSettled(
            subs.map(async (sub) => {
              detachSubscriber(sub);
              const finalError = asSubscriberError(error, sub.config);
              await safeInvokeErrorHook(sub.config, finalError);
              sub.reject(finalError);
            }),
          );
        },
      );
    }

    return new Promise<CorriereResponse>((resolve, reject) => {
      const subscriber: Subscriber = {
        config,
        resolve,
        reject,
        signal: config.signal,
      };

      if (config.signal) {
        if (config.signal.aborted) {
          reject(createCanceledError(config));
          return;
        }
        const onAbort = () => {
          record!.subscribers.delete(subscriber);
          reject(createCanceledError(config));
          if (record!.subscribers.size === 0) {
            record!.abortController.abort(config.signal!.reason);
          }
        };
        subscriber.onAbort = onAbort;
        config.signal.addEventListener('abort', onAbort, { once: true });
      }

      record!.subscribers.add(subscriber);
    });
  }

  const promise = executeFetchRequest(config, fullURL, flatHeaders);

  try {
    const shared = await promise;
    const settled = await finalizeAndSettle(shared, config, {
      isGet,
      cacheKey,
      registry,
      cloneRaw: false,
      writeCache: true,
    });

    if (config.hooks?.onRequestResponse) {
      await config.hooks.onRequestResponse(settled);
    }

    return settled;
  } catch (error) {
    await safeInvokeErrorHook(config, error);
    throw error;
  }
}

function cloneResponse(response: CorriereResponse): CorriereResponse {
  let clonedData = response.data;
  if (response.data && typeof response.data === 'object') {
    if (
      !(typeof File !== 'undefined' && response.data instanceof File) &&
      !(typeof Blob !== 'undefined' && response.data instanceof Blob) &&
      !(typeof ArrayBuffer !== 'undefined' && response.data instanceof ArrayBuffer) &&
      !(typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(response.data)) &&
      !(typeof Buffer !== 'undefined' && Buffer.isBuffer(response.data)) &&
      !(typeof ReadableStream !== 'undefined' && response.data instanceof ReadableStream)
    ) {
      try {
        if (typeof structuredClone === 'function') {
          clonedData = structuredClone(response.data);
        } else {
          clonedData = JSON.parse(JSON.stringify(response.data));
        }
      } catch {
        clonedData = Array.isArray(response.data) ? [...response.data] : { ...response.data };
      }
    }
  }
  return {
    ...response,
    headers: { ...response.headers },
    data: clonedData,
  };
}

/**
 * Attaches the caller's own config to a response.
 *
 * Deliberately unredacted: this is the config the caller already holds, and redacting it
 * made `response.config.headers` read `[REDACTED]`, so callers could not inspect the
 * headers they had just sent. Redaction is applied to errors (see `redactConfig`), which
 * are the values that leak into logs and crash reporters.
 */
function finalizeResponse(
  shared: CorriereResponse,
  config: CorriereRequestConfig,
): CorriereResponse {
  return {
    ...shared,
    config,
  };
}
