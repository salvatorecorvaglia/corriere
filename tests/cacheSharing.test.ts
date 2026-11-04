import { describe, expect, it, vi } from 'vitest';
import { cacheKeyFor } from '../src/core/request';
import corriere, { type CorriereRequestConfig, MemoryCache } from '../src/index';

const url = 'https://api.test.com/shared';
const response = (status = 200) =>
  new Response('{"value":1}', {
    status,
    headers: [
      ['content-type', 'application/json'],
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
    ],
  });

function provider() {
  const cache = new MemoryCache();
  return { cache, set: vi.spyOn(cache, 'set') };
}

async function shared(configs: CorriereRequestConfig[], status = 200) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    await gate;
    return response(status);
  });
  const client = corriere.create({ fetch, dedupe: true });
  const requests = configs.map((config) => client.get(url, config));
  // Let all cache lookups and subscriptions finish before completing the transport.
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  const results = await Promise.allSettled(requests);
  expect(fetch).toHaveBeenCalledTimes(1);
  return { client, fetch, results };
}

describe('response-affecting request headers', () => {
  it.each(['User-Agent', 'Host', 'Accept-Encoding', 'Connection', 'Content-Length'])(
    'separates cached and inflight responses by %s',
    async (name) => {
      const fetch = vi.fn<typeof globalThis.fetch>(
        async (_url, init) => new Response(new Headers(init?.headers).get(name)),
      );
      const client = corriere.create({ fetch, cache: true, dedupe: true, responseType: 'text' });
      const [first, second] = await Promise.all([
        client.get(url, { headers: { [name]: 'first' } }),
        client.get(url, { headers: { [name]: 'second' } }),
      ]);
      expect(first.data).toBe('first');
      expect(second.data).toBe('second');
      expect((await client.get(url, { headers: { [name]: 'second' } })).data).toBe('second');
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('normalizes header case and order and invalidates the matching variant', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    const client = corriere.create({ fetch, cache: true });
    await client.get(url, { headers: { 'User-Agent': 'one', 'X-Mode': 'a' } });
    await client.get(url, { headers: { 'x-mode': 'a', 'user-agent': 'one' } });
    await client.get(url, { headers: { 'User-Agent': 'two', 'X-Mode': 'a' } });
    expect(fetch).toHaveBeenCalledTimes(2);
    client.invalidate(url, { headers: { 'user-agent': 'one', 'x-mode': 'a' } });
    await client.get(url, { headers: { 'User-Agent': 'two', 'X-Mode': 'a' } });
    await client.get(url, { headers: { 'User-Agent': 'one', 'X-Mode': 'a' } });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(cacheKeyFor({ url })).toMatch(/^v4:/);
  });
});

describe('response header ownership', () => {
  it.each([true, false])(
    'isolates cache snapshots and cache hits with cacheClone=%s',
    async (cacheClone) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
      const client = corriere.create({ fetch, cache: true, cacheClone });
      const first = await client.get(url);
      (first.headers['set-cookie'] as string[]).push('first=mutation');
      const second = await client.get(url);
      expect(second.headers['set-cookie']).toEqual(['a=1', 'b=2']);
      (second.headers['set-cookie'] as string[]).push('second=mutation');
      expect((await client.get(url)).headers['set-cookie']).toEqual(['a=1', 'b=2']);
      expect(fetch).toHaveBeenCalledTimes(1);
      if (!cacheClone) expect(first.data).toBe(second.data);
    },
  );

  it.each([true, false])(
    'isolates dedupe headers before response transforms with cacheClone=%s',
    async (cacheClone) => {
      const { results } = await shared([
        {
          cacheClone,
          transformResponse(data, headers) {
            (headers['set-cookie'] as string[]).push('private=1');
            return data;
          },
        },
        { cacheClone },
      ]);
      expect(results[0]).toMatchObject({
        status: 'fulfilled',
        value: { headers: { 'set-cookie': ['a=1', 'b=2', 'private=1'] } },
      });
      expect(results[1]).toMatchObject({
        status: 'fulfilled',
        value: { headers: { 'set-cookie': ['a=1', 'b=2'] } },
      });
    },
  );
});

describe('dedupe subscriber cache policies', () => {
  it('retains a raw snapshot when the first subscriber mutates its response and then rejects', async () => {
    const { cache, set } = provider();
    const { client, results, fetch } = await shared([
      {
        cache,
        transformResponse(data) {
          (data as { value: number }).value = 99;
          throw new Error('transform rejected');
        },
      },
      { cache },
    ]);
    expect(results[0].status).toBe('rejected');
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: { data: { value: 1 } } });
    expect(set).toHaveBeenCalledTimes(1);
    expect((await client.get(url, { cache })).data).toEqual({ value: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps provider mutations separate from every subscriber response', async () => {
    const cache = {
      get: () => null,
      set: vi.fn((_key: string, entry: { data: { value: number } }) => {
        entry.data.value = 99;
      }),
      delete() {},
      clear() {},
    };
    const { results } = await shared([{ cache }, { cache }]);
    expect(cache.set).toHaveBeenCalledTimes(1);
    for (const result of results)
      expect(result).toMatchObject({ status: 'fulfilled', value: { data: { value: 1 } } });
  });

  it('populates a later subscriber provider when the first caller disables caching', async () => {
    const { cache, set } = provider();
    const { client, fetch, results } = await shared([{ cache: false }, { cache, cacheTTL: 1234 }]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][2]).toBe(1234);
    await client.get(url, { cache });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('populates distinct providers with their own TTLs and raw data', async () => {
    const first = provider(),
      second = provider();
    const { client, fetch } = await shared([
      { cache: first.cache, cacheTTL: 1000, transformResponse: () => ({ private: true }) },
      { cache: second.cache, cacheTTL: 2000 },
    ]);
    expect(first.set.mock.calls[0][2]).toBe(1000);
    expect(second.set.mock.calls[0][2]).toBe(2000);
    expect(first.set.mock.calls[0][1]).not.toHaveProperty('config');
    expect((await client.get(url, { cache: first.cache })).data).toEqual({ value: 1 });
    expect((await client.get(url, { cache: second.cache })).data).toEqual({ value: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('coalesces equivalent provider writes and retains differing TTL writes', async () => {
    const { cache, set } = provider();
    await shared([
      { cache, cacheTTL: 1000 },
      { cache, cacheTTL: 1000 },
      { cache, cacheTTL: 2000 },
    ]);
    expect(set).toHaveBeenCalledTimes(2);
    expect(set.mock.calls.map((call) => call[2]).sort()).toEqual([1000, 2000]);
  });

  it('lets an accepting subscriber cache when the first caller rejects the status', async () => {
    const other = provider();
    const run = await shared([
      { cache: other.cache, validateStatus: () => false },
      { cache: other.cache },
    ]);
    expect(run.results[0].status).toBe('rejected');
    expect(run.results[1].status).toBe('fulfilled');
    expect(other.set).toHaveBeenCalledTimes(1);
  });

  it('keeps cache provider failures local to subscribers using that provider', async () => {
    const broken = {
      get: () => null,
      set: vi.fn(async () => {
        throw new Error('cache unavailable');
      }),
      delete() {},
      clear() {},
    };
    const healthy = provider();
    const { results } = await shared([
      { cache: broken },
      { cache: broken },
      { cache: healthy.cache },
      { cache: false },
    ]);
    expect(results.map((r) => r.status)).toEqual([
      'rejected',
      'rejected',
      'fulfilled',
      'fulfilled',
    ]);
    expect(broken.set).toHaveBeenCalledTimes(1);
    expect(healthy.set).toHaveBeenCalledTimes(1);
  });

  it('does not let a zero-TTL subscriber prevent another subscriber from storing', async () => {
    const { cache, set } = provider();
    await shared([
      { cache, cacheTTL: 0 },
      { cache, cacheTTL: 1000 },
    ]);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][2]).toBe(1000);
  });

  it('keeps differing clone policies separate while retaining payload opt-out semantics', async () => {
    const { cache, set } = provider();
    const { results } = await shared([{ cache }, { cache, cacheClone: false }]);
    expect(set).toHaveBeenCalledTimes(2);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
  });

  it('awaits an equivalent async write without delaying subscribers that disable caching', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const set = vi.fn(async () => {
      await gate;
    });
    const cache = { get: () => null, set, delete() {}, clear() {} };
    const client = corriere.create({ dedupe: true, fetch: async () => response() });
    let settled = 0;
    const first = client.get(url, { cache }).then((result) => {
      settled++;
      return result;
    });
    const second = client.get(url, { cache }).then((result) => {
      settled++;
      return result;
    });
    try {
      await expect(client.get(url, { cache: false })).resolves.toMatchObject({
        data: { value: 1 },
      });
      expect(set).toHaveBeenCalledTimes(1);
      expect(settled).toBe(0);
    } finally {
      release();
      await Promise.all([first, second]);
    }
    expect(settled).toBe(2);
  });
});
