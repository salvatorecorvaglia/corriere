import type { CorriereRequestConfig, CorriereResponse } from '../types';
import { buildCacheKey, buildDedupeKey } from './cacheIdentity';
import CorriereError, { FROM_CACHE } from './corriereError';
import fetchAdapter from './fetchAdapter';
import { deduplicateRequest } from './inflightRequests';
import { type PreparedRequest, prepareRequest } from './requestPreparation';
import { createRegistry, type RequestRegistry } from './requestRegistry';
import { resolveCacheProvider } from './responseCache';
import { discardStream, finalizeAndSettle, safeInvokeErrorHook } from './responseProcessing';

export { cacheKeyFor } from './cacheIdentity';
export { createRegistry, type RequestRegistry } from './requestRegistry';
export { DEFAULT_CACHE_TTL } from './responseCache';

const defaultRegistry = createRegistry();

function throwIfCanceled(config: CorriereRequestConfig): void {
  if (config.signal?.aborted) {
    throw CorriereError.canceled(config.signal.reason, config);
  }
}

function executePreparedRequest(
  prepared: PreparedRequest,
  config: CorriereRequestConfig = prepared.config,
): Promise<CorriereResponse> {
  throwIfCanceled(config);
  return fetchAdapter(config, prepared.url, { ...prepared.options }, Date.now());
}

export default async function dispatchRequest(
  config: CorriereRequestConfig,
  registry: RequestRegistry = defaultRegistry,
): Promise<CorriereResponse> {
  throwIfCanceled(config);
  let prepared: PreparedRequest;
  try {
    prepared = await prepareRequest(config);
  } catch (error) {
    await safeInvokeErrorHook(config, error);
    throw error;
  }
  const { url: fullURL, headers: flatHeaders } = prepared;

  const isGet = (config.method || 'GET').toUpperCase() === 'GET';
  // A stream body can be read exactly once and cannot be cloned, so a stream response is
  // never cached (a replay would hand back an already-drained stream) and never deduped
  // (every caller would share one stream that only the first could read).
  // Runtime transport objects cannot be represented safely in persistent cache keys.
  // Overrides use an independent request; create a client for a reusable transport.
  const sameTransport =
    config.fetch === registry.transport.fetch &&
    config.dispatcher === registry.transport.dispatcher &&
    config.agent === registry.transport.agent;
  const cacheable = isGet && config.responseType !== 'stream' && sameTransport;
  const cacheKey =
    cacheable && (config.cache || config.dedupe)
      ? buildCacheKey(
          config,
          fullURL,
          flatHeaders,
          prepared.options.headers instanceof Headers ? prepared.options.headers : undefined,
        )
      : '';
  const dedupeKey = cacheKey && buildDedupeKey(config, cacheKey);

  if (cacheable && config.cache) {
    const cached = await resolveCacheProvider(config.cache, registry).get(cacheKey);
    throwIfCanceled(config);
    if (cached) {
      try {
        // A replay runs this caller's transforms, validateStatus and schema, exactly as a
        // live response would — see `finalizeAndSettle`.
        const settled = await finalizeAndSettle(cached, config, {
          cacheable,
          cacheKey,
          registry,
          cloneRaw: true,
          writeCache: false,
        });
        if (config.hooks?.onRequestResponse) {
          await config.hooks.onRequestResponse(settled);
        }
        return settled;
      } catch (error) {
        // Tells `retryRequest` not to bother: the value came from the cache, so every
        // further attempt would read the same entry back and fail the same way.
        if (error instanceof CorriereError) {
          Object.assign(error, { [FROM_CACHE]: true });
        }
        await safeInvokeErrorHook(config, error);
        throw error;
      }
    }
  }

  // Progress belongs to each download observer; sharing one adapter would notify
  // only its first caller. Cache hits still have no download to report.
  if (cacheable && config.dedupe && !config.onDownloadProgress) {
    return deduplicateRequest(config, registry, dedupeKey, cacheKey, (signal) =>
      executePreparedRequest(prepared, { ...config, signal }),
    );
  }

  const promise = executePreparedRequest(prepared);
  let streamBody: unknown;

  try {
    const shared = await promise;
    if (config.responseType === 'stream') streamBody = shared.data;
    const settled = await finalizeAndSettle(shared, config, {
      cacheable,
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
    await discardStream(streamBody);
    await safeInvokeErrorHook(config, error);
    throw error;
  }
}
