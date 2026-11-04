import { buildFetchHeaders } from '../helpers/flattenHeaders';
import type { CorriereRequestConfig } from '../types';
import { resolveURL } from './buildURL';
import { DEFAULT_ALLOWED_PROTOCOLS } from './protocol';
import { finishHeaders, requestHeaders } from './requestPreparation';

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
 * This digest is not a cryptographic security boundary. Canonical serialization below
 * prevents structural collisions before hashing; the digest still has a finite collision
 * probability and must not be used as proof of authorization.
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

/** Transport acceptance policies must not be borrowed from a different caller. */
function sharingPolicy(config: CorriereRequestConfig): string {
  return JSON.stringify([
    config.maxContentLength ?? null,
    config.maxRedirects ?? null,
    config.allowedProtocols === null
      ? null
      : [...(config.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS)].sort(),
  ]);
}

export function buildCacheKey(
  config: CorriereRequestConfig,
  fullURL: string,
  flatHeaders: FlatHeaders,
  wireHeaders?: Headers,
): string {
  if (typeof config.cacheKeySerializer === 'function') {
    return config.cacheKeySerializer(config, fullURL, flatHeaders);
  }
  const method = (config.method || 'GET').toUpperCase();
  const withCreds = config.withCredentials ? '1' : '0';
  const respType = config.responseType || 'json';

  // Serialize normalized wire headers as tuples: delimiters in a value must never
  // make a single header indistinguishable from multiple headers.
  const serializedHeaders = JSON.stringify(
    Array.from((wireHeaders ?? buildFetchHeaders(flatHeaders)).entries()).sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );

  return `v4:${method}:${fullURL}|h:${hashHeaders(serializedHeaders)}|c=${withCreds}|t=${respType}|p=${sharingPolicy(config)}`;
}

/**
 * The cache key for an already prepared URL/header configuration. Invalidation stays
 * synchronous and does not run hooks, interceptors, or request transforms: callers must
 * supply their final URL and header values if those stages change the request.
 */
export function cacheKeyFor(config: CorriereRequestConfig): string {
  const fullURL = resolveURL(config);
  const flatHeaders = requestHeaders(config);
  finishHeaders(flatHeaders, config.data, config);
  return buildCacheKey(config, fullURL, flatHeaders);
}

/**
 * Dedupe collapses two calls into one *in-flight request*, so it must additionally
 * separate configs that would behave differently on the wire even though they would cache
 * identically. Timeout is not part of the cache key. Policies are repeated here so even
 * a custom cache key cannot collapse inflight requests with different transport limits.
 */
export function buildDedupeKey(config: CorriereRequestConfig, cacheKey: string): string {
  return `${cacheKey}|to=${config.timeout ?? 0}|p=${sharingPolicy(config)}`;
}
