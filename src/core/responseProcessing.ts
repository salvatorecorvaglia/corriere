import settle from '../helpers/settle';
import transformData from '../helpers/transformData';
import type { CorriereRequestConfig, CorriereResponse, TransformFunction } from '../types';
import CorriereError from './corriereError';
import {
  type CacheWrites,
  cloneResponse,
  DEFAULT_CACHE_TTL,
  prepareCacheWrite,
  type ResponseCache,
  resolveCacheProvider,
  type UnsettledResponse,
} from './responseCache';

function buildTransformArray(
  transform: TransformFunction | TransformFunction[] | undefined,
): TransformFunction[] {
  if (!transform) return [];
  if (Array.isArray(transform)) return transform;
  return [transform];
}

function settleResponse(
  response: CorriereResponse,
  config: CorriereRequestConfig,
): Promise<CorriereResponse> {
  return new Promise<CorriereResponse>((resolve, reject) => {
    settle(resolve, reject, response, config);
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
 * Turns a raw adapter response — live, or replayed from the cache — into the value handed
 * back to one caller: applies that caller's `transformResponse`, enforces `validateStatus`,
 * stores the server's response if caching is on, then applies `schema`.
 *
 * The cache holds what the server sent, not what any one caller made of it. The entry is
 * snapshotted *before* `transformResponse` runs and written only *after* settling:
 *
 * - Before transforming, because storing a caller's transformed data handed that shape to
 *   every later caller, whatever transforms they passed — and a transform that mutates its
 *   input in place would otherwise corrupt the snapshot.
 * - After settling, because storing first meant a 4xx/5xx was written to the cache and then
 *   replayed to later callers as a resolved success, silently bypassing `validateStatus`.
 * - Before `applySchema`, which mutates `settled.data` in place; a schema that reshapes its
 *   input (a Zod `.transform()`, say) must not write its output into a shared cache.
 *
 * A cache hit comes back through this same function with `writeCache: false`, so every
 * reader gets its own transforms, status check and schema, exactly as on a live request.
 *
 * `cloneRaw` is set when `raw` is shared — the dedupe fan-out, where several callers split
 * one adapter response, and a cache hit — so each caller gets an independent copy. A live
 * single-consumer response is its caller's alone, so cloning it would be pure overhead.
 *
 * Each dedupe subscriber applies its own cache policy after accepting the response.
 * Equivalent writes share a promise; distinct providers, TTLs and clone policies do not.
 */
export async function finalizeAndSettle(
  raw: UnsettledResponse,
  config: CorriereRequestConfig,
  options: {
    cacheable: boolean;
    cacheKey: string;
    cloneRaw: boolean;
    writeCache: boolean;
    registry: { cache: ResponseCache };
    cacheWrites?: CacheWrites;
  },
): Promise<CorriereResponse> {
  const clone = config.cacheClone !== false;
  const source = options.cloneRaw ? cloneResponse(raw, clone) : raw;

  const ttl = config.cacheTTL ?? DEFAULT_CACHE_TTL;
  const storeResponse =
    options.writeCache && options.cacheable && config.cache && ttl > 0
      ? prepareCacheWrite(
          resolveCacheProvider(config.cache, options.registry),
          options.cacheKey,
          source,
          ttl,
          clone,
          options.cacheWrites,
        )
      : null;

  const response = finalizeResponse(source, config);

  response.data = await transformData(
    buildTransformArray(config.transformResponse),
    response.data,
    response.headers,
    config,
    'response',
  );

  const settled = await settleResponse(response, config);

  if (storeResponse) await storeResponse();

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
export async function safeInvokeErrorHook(
  config: CorriereRequestConfig,
  error: unknown,
): Promise<void> {
  if (!config.hooks?.onRequestError || !(error instanceof CorriereError)) return;
  try {
    await config.hooks.onRequestError(error);
  } catch {
    // Intentionally swallowed; see above.
  }
}

/** Release a body if response processing fails before ownership reaches the caller. */
export async function discardStream(body: unknown): Promise<void> {
  try {
    if (body && typeof body === 'object') {
      if ('cancel' in body && typeof body.cancel === 'function') await body.cancel();
      else if ('destroy' in body && typeof body.destroy === 'function') body.destroy();
    }
  } catch {
    // Cleanup must not replace the processing failure.
  }
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
  shared: UnsettledResponse,
  config: CorriereRequestConfig,
): CorriereResponse {
  return {
    ...shared,
    config,
  };
}
