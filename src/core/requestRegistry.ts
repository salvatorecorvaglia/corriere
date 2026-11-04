import { MemoryCache } from '../helpers/memoryCache';
import type { CorriereRequestConfig } from '../types';
import type { InFlightRecord } from './inflightRequests';
import type { ResponseCache } from './responseCache';

/**
 * The dedupe and cache state one client owns.
 *
 * Both used to be module globals, so every instance `create()` produced shared them. Two
 * clients configured with different transports (`config.fetch`, `dispatcher`, `agent`) but
 * the same URL collapsed into a single request and each could receive the other's
 * response. Each registry captures its original transport: per-call overrides bypass
 * sharing because runtime object identity cannot be persisted in a cache key. Owning the
 * registry also isolates instances and makes tests independent.
 */
export interface RequestRegistry {
  inflight: Map<string, InFlightRecord>;
  cache: ResponseCache;
  transport: Pick<CorriereRequestConfig, 'fetch' | 'dispatcher' | 'agent'>;
}

export function createRegistry(config: CorriereRequestConfig = {}): RequestRegistry {
  return {
    inflight: new Map<string, InFlightRecord>(),
    cache: new MemoryCache(),
    transport: { fetch: config.fetch, dispatcher: config.dispatcher, agent: config.agent },
  };
}
