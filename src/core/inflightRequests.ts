import type { CorriereRequestConfig, CorriereResponse } from '../types';
import CorriereError from './corriereError';
import type { RequestRegistry } from './requestRegistry';
import type { CacheWrites } from './responseCache';
import { finalizeAndSettle, safeInvokeErrorHook } from './responseProcessing';

interface Subscriber {
  config: CorriereRequestConfig;
  resolve: (res: CorriereResponse) => void;
  reject: (err: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface InFlightRecord {
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

export function deduplicateRequest(
  config: CorriereRequestConfig,
  registry: RequestRegistry,
  dedupeKey: string,
  cacheKey: string,
  start: (signal: AbortSignal) => Promise<CorriereResponse>,
): Promise<CorriereResponse> {
  let record = registry.inflight.get(dedupeKey);
  if (!record) {
    const recordAbortController = new AbortController();
    const promise = start(recordAbortController.signal);

    const createdRecord: InFlightRecord = {
      promise,
      abortController: recordAbortController,
      subscribers: new Set<Subscriber>(),
    };

    record = createdRecord;
    trackActiveRequest(registry, dedupeKey, createdRecord);

    // Both branches deliver with `Promise.allSettled` over a snapshot of the subscriber
    // set. Snapshot because an aborting subscriber removes itself mid-iteration;
    // `allSettled` because delivery is per-subscriber work — a slow (or broken)
    // `onRequestResponse` on one caller must not hold up everybody behind it, and
    // nothing here is allowed to reject the outer promise, which has no handler.
    promise.then(
      async (shared) => {
        if (registry.inflight.get(dedupeKey) === createdRecord) {
          registry.inflight.delete(dedupeKey);
        }
        const subs = [...createdRecord.subscribers];
        const cacheWrites: CacheWrites = new Map();
        await Promise.allSettled(
          subs.map(async (sub) => {
            detachSubscriber(sub);
            try {
              const settled = await finalizeAndSettle(shared, sub.config, {
                cacheable: true,
                cacheKey,
                registry,
                cloneRaw: true,
                writeCache: true,
                cacheWrites,
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
      async (error: unknown) => {
        if (registry.inflight.get(dedupeKey) === createdRecord) {
          registry.inflight.delete(dedupeKey);
        }
        const subs = [...createdRecord.subscribers];
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

  const subscribedRecord = record;
  return new Promise<CorriereResponse>((resolve, reject) => {
    const subscriber: Subscriber = {
      config,
      resolve,
      reject,
      signal: config.signal,
    };

    const signal = config.signal;
    if (signal) {
      if (signal.aborted) {
        reject(CorriereError.canceled(signal.reason, config));
        if (subscribedRecord.subscribers.size === 0) {
          if (registry.inflight.get(dedupeKey) === subscribedRecord) {
            registry.inflight.delete(dedupeKey);
          }
          subscribedRecord.abortController.abort(signal.reason);
        }
        return;
      }
      const onAbort = () => {
        subscribedRecord.subscribers.delete(subscriber);
        reject(CorriereError.canceled(signal.reason, config));
        if (subscribedRecord.subscribers.size === 0) {
          // Unregistered *before* aborting. The aborted fetch only rejects a tick or more
          // later, and until then a new caller for the same key would join this doomed
          // record and receive a cancellation it never asked for.
          if (registry.inflight.get(dedupeKey) === subscribedRecord) {
            registry.inflight.delete(dedupeKey);
          }
          subscribedRecord.abortController.abort(signal.reason);
        }
      };
      subscriber.onAbort = onAbort;
      signal.addEventListener('abort', onAbort, { once: true });
    }

    subscribedRecord.subscribers.add(subscriber);
  });
}
