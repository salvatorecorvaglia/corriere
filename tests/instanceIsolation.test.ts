import { beforeEach, describe, expect, it, vi } from 'vitest';
import dispatchRequest, { createRegistry, DEFAULT_CACHE_TTL } from '../src/core/request';
import corriere from '../src/index';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Dedupe and cache state used to be module globals shared by every instance `create()`
 * produced. Nothing that distinguishes two transports — `config.fetch`, `dispatcher`,
 * `agent` — is or could reasonably be part of a cache key, so two clients pointed at the
 * same URL could serve each other's responses.
 */
describe('clients do not share dedupe or cache state', () => {
  it('keeps two instances with different transports apart under dedupe', async () => {
    const clientA = corriere.create({ fetch: () => Promise.resolve(jsonResponse({ who: 'A' })) });
    const clientB = corriere.create({ fetch: () => Promise.resolve(jsonResponse({ who: 'B' })) });

    const [a, b] = await Promise.all([
      clientA.get('https://api.test.com/shared', { dedupe: true }),
      clientB.get('https://api.test.com/shared', { dedupe: true }),
    ]);

    expect(a.data).toEqual({ who: 'A' });
    expect(b.data).toEqual({ who: 'B' });
  });

  it('keeps two instances apart under caching', async () => {
    const clientA = corriere.create({ fetch: () => Promise.resolve(jsonResponse({ who: 'A' })) });
    const clientB = corriere.create({ fetch: () => Promise.resolve(jsonResponse({ who: 'B' })) });

    await clientA.get('https://api.test.com/thing', { cache: true });
    const b = await clientB.get('https://api.test.com/thing', { cache: true });

    expect(b.data).toEqual({ who: 'B' });
  });

  it('separates in-flight requests that differ only by timeout', async () => {
    let calls = 0;
    const client = corriere.create({
      fetch: () => {
        calls++;
        return Promise.resolve(jsonResponse({ ok: true }));
      },
    });

    await Promise.all([
      client.get('https://api.test.com/t', { dedupe: true, timeout: 1000 }),
      client.get('https://api.test.com/t', { dedupe: true, timeout: 5000 }),
    ]);

    // Different wire behaviour, so they must not collapse into one request.
    expect(calls).toBe(2);
  });

  it('still dedupes two identical calls on one instance', async () => {
    let calls = 0;
    const client = corriere.create({
      fetch: () => {
        calls++;
        return Promise.resolve(jsonResponse({ ok: true }));
      },
    });

    await Promise.all([
      client.get('https://api.test.com/same', { dedupe: true }),
      client.get('https://api.test.com/same', { dedupe: true }),
    ]);

    expect(calls).toBe(1);
  });
});

/**
 * With the cache instance-owned and unexported, a user who enabled `cache: true` had no
 * supported way to invalidate anything.
 */
describe('cache management API', () => {
  let calls: number;
  let client: ReturnType<typeof corriere.create>;

  beforeEach(() => {
    calls = 0;
    client = corriere.create({
      fetch: () => {
        calls++;
        return Promise.resolve(jsonResponse({ n: calls }));
      },
    });
  });

  it('clearCache() drops everything', async () => {
    await client.get('https://api.test.com/a', { cache: true });
    await client.get('https://api.test.com/a', { cache: true });
    expect(calls).toBe(1);

    client.clearCache();

    await client.get('https://api.test.com/a', { cache: true });
    expect(calls).toBe(2);
  });

  it('invalidate() drops one entry and leaves the others', async () => {
    await client.get('https://api.test.com/a', { cache: true });
    await client.get('https://api.test.com/b', { cache: true });
    expect(calls).toBe(2);

    client.invalidate('https://api.test.com/a', { cache: true });

    await client.get('https://api.test.com/a', { cache: true });
    expect(calls).toBe(3);
    await client.get('https://api.test.com/b', { cache: true });
    expect(calls).toBe(3);
  });

  it('exports MemoryCache so a caller can supply their own', () => {
    expect(typeof corriere.MemoryCache).toBe('function');
    const cache = new corriere.MemoryCache(2);
    cache.set('k', 1);
    expect(cache.get('k')).toBe(1);
  });
});

/**
 * `cache: true` with no `cacheTTL` used to mean "never expires", which is an unbounded
 * staleness window rather than a cache.
 */
describe('cacheTTL', () => {
  it('defaults to a finite TTL rather than forever', async () => {
    expect(DEFAULT_CACHE_TTL).toBeGreaterThan(0);

    const ttls: Array<number | undefined> = [];
    const provider = {
      get: () => null,
      set: (_k: string, _v: unknown, ttl?: number) => {
        ttls.push(ttl);
      },
      delete: () => {},
      clear: () => {},
    };

    global.fetch = vi.fn(() => Promise.resolve(jsonResponse({ ok: true }))) as any;
    await dispatchRequest(
      { url: 'https://api.test.com/x', method: 'get', cache: provider } as any,
      createRegistry(),
    );

    expect(ttls).toEqual([DEFAULT_CACHE_TTL]);
  });

  it('treats cacheTTL: 0 as "do not cache this call"', async () => {
    const set = vi.fn();
    const provider = { get: () => null, set, delete: () => {}, clear: () => {} };

    global.fetch = vi.fn(() => Promise.resolve(jsonResponse({ ok: true }))) as any;
    await dispatchRequest(
      { url: 'https://api.test.com/x', method: 'get', cache: provider, cacheTTL: 0 } as any,
      createRegistry(),
    );

    expect(set).not.toHaveBeenCalled();
  });
});

describe('empty JSON responses', () => {
  it('yields null rather than an empty string', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response('', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    ) as any;

    const res = await dispatchRequest({ url: 'https://api.test.com/empty', method: 'get' } as any);
    expect(res.data).toBeNull();
  });
});
