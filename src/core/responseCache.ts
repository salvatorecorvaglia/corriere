import { isBinaryData, isReadableStream } from '../helpers/isBinary';
import type { CorriereRequestConfig, CorriereResponse } from '../types';

/** Cached payloads never own a caller's config; only finalized responses require it. */
export type CacheEntry = Omit<CorriereResponse<unknown>, 'config'>;
export type UnsettledResponse = CacheEntry & { config?: CorriereRequestConfig };

export interface ResponseCache {
  get(key: string): CacheEntry | null | undefined | Promise<CacheEntry | null | undefined>;
  set(key: string, entry: CacheEntry, ttl?: number): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  clear(): void | Promise<void>;
}

interface CacheWrite {
  entry: CacheEntry;
  promise?: Promise<void>;
}

/** Snapshots and writes are shared only for equivalent subscriber cache policies. */
export type CacheWrites = Map<ResponseCache, Map<string, CacheWrite>>;

/** Snapshot before transforms; start the write only after this caller accepts the status. */
export function prepareCacheWrite(
  provider: ResponseCache,
  key: string,
  raw: UnsettledResponse,
  ttl: number,
  clone: boolean,
  writes?: CacheWrites,
): () => Promise<void> {
  let policies = writes?.get(provider);
  if (writes && !policies) {
    policies = new Map();
    writes.set(provider, policies);
  }
  const policy = JSON.stringify([key, ttl, clone]);
  let record = policies?.get(policy);
  if (!record) {
    record = { entry: toCacheEntry(cloneResponse(raw, clone)) };
    policies?.set(policy, record);
  }
  const snapshot = record;
  return () => {
    // Register the promise before invoking a provider, covering synchronous throws.
    snapshot.promise ??= Promise.resolve().then(() => provider.set(key, snapshot.entry, ttl));
    return snapshot.promise;
  };
}

export const DEFAULT_CACHE_TTL = 300_000;

export function resolveCacheProvider(
  cache: CorriereRequestConfig['cache'],
  registry: { cache: ResponseCache },
): ResponseCache {
  // Public providers remain permissively typed for compatibility. The request
  // pipeline reads back the response-entry shape it writes through this boundary.
  return typeof cache === 'object' ? cache : registry.cache;
}

/**
 * The value stored in a cache: a response minus its `config`.
 *
 * `config` is overwritten with the reader's own config on every cache hit, so storing it
 * only kept the caller's request body, signal and hook closures alive for the whole TTL.
 */
export function toCacheEntry(response: UnsettledResponse): CacheEntry {
  const { config: _config, ...entry } = response;
  return entry;
}

export function cloneResponse(response: UnsettledResponse, cloneData = true): UnsettledResponse {
  let clonedData = response.data;
  if (cloneData && response.data && typeof response.data === 'object') {
    if (response.data instanceof ArrayBuffer) {
      clonedData = response.data.slice(0);
    } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(response.data)) {
      clonedData = Buffer.from(response.data);
    } else if (ArrayBuffer.isView(response.data)) {
      const view = response.data;
      const buffer = new ArrayBuffer(view.byteLength);
      new Uint8Array(buffer).set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
      clonedData =
        view instanceof DataView
          ? new DataView(buffer)
          : new (view.constructor as new (buffer: ArrayBuffer) => ArrayBufferView)(buffer);
    } else if (!isBinaryData(response.data) && !isReadableStream(response.data)) {
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
    headers: Object.fromEntries(
      Object.entries(response.headers).map(([key, value]) => [
        key,
        Array.isArray(value) ? [...value] : value,
      ]),
    ),
    data: clonedData,
  };
}
