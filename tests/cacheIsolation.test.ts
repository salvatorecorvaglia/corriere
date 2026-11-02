import { describe, expect, it, vi } from 'vitest';
import corriere from '../src/index';
import type { CorriereRequestConfig } from '../src/types';

const url = 'https://example.test/items';
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });

describe('transport policy isolation', () => {
  it.each(['cache', 'dedupe'] as const)(
    'enforces each caller’s response size limit with %s',
    async (feature) => {
      const fetch = vi.fn(async () => new Response('abcdefghij'));
      const client = corriere.create({ fetch, [feature]: true });
      const unbounded = client.get(url);
      if (feature === 'cache') await unbounded;
      const bounded = client.get(url, { maxContentLength: 2 });
      const results = await Promise.allSettled([unbounded, bounded]);
      expect(results[0].status).toBe('fulfilled');
      expect(results[1]).toMatchObject({
        status: 'rejected',
        reason: { code: 'ERR_BAD_RESPONSE' },
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['cache', 'dedupe'] as const)('preserves redirect policy with %s', async (feature) => {
    const fetch = vi.fn(async (input: unknown) =>
      String(input) === url
        ? new Response(null, { status: 302, headers: { location: '/final' } })
        : json('final'),
    );
    const client = corriere.create({ fetch, [feature]: true });
    const followed = client.get(url, { maxRedirects: 1 });
    if (feature === 'cache') await followed;
    const stopped = client.get(url, { maxRedirects: 0 });
    const results = await Promise.allSettled([followed, stopped]);
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { data: 'final' } });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { response: { status: 302 } } });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('separates redirect protocol allowlists under dedupe', async () => {
    const fetch = vi.fn(async (input: unknown) =>
      String(input) === url
        ? new Response(null, { status: 302, headers: { location: 'http://example.test/final' } })
        : json('final'),
    );
    const client = corriere.create({ fetch, dedupe: true, maxRedirects: 1 });
    const results = await Promise.allSettled([
      client.get(url),
      client.get(url, { allowedProtocols: ['https:'] }),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'ERR_BAD_OPTION' } });
  });

  it('delivers download progress to both concurrent callers', async () => {
    const fetch = vi.fn(async () => new Response('download'));
    const client = corriere.create({ fetch, dedupe: true });
    const first = vi.fn();
    const second = vi.fn();
    await Promise.all([
      client.get(url, { onDownloadProgress: first }),
      client.get(url, { onDownloadProgress: second }),
    ]);
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('binary response isolation', () => {
  it('protects the cached ArrayBuffer from live and replayed response mutations', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2])));
    const client = corriere.create({ fetch, cache: true, responseType: 'arraybuffer' });
    const first = await client.get<ArrayBuffer>(url);
    new Uint8Array(first.data)[0] = 99;
    const second = await client.get<ArrayBuffer>(url);
    expect(Array.from(new Uint8Array(second.data))).toEqual([1, 2]);
    new Uint8Array(second.data)[1] = 88;
    const third = await client.get<ArrayBuffer>(url);
    expect(Array.from(new Uint8Array(third.data))).toEqual([1, 2]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives deduplicated callers separate ArrayBuffers', async () => {
    const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2])));
    const client = corriere.create({ fetch, dedupe: true, responseType: 'arraybuffer' });
    const [first, second] = await Promise.all([
      client.get<ArrayBuffer>(url),
      client.get<ArrayBuffer>(url),
    ]);
    new Uint8Array(first.data)[0] = 99;
    expect(Array.from(new Uint8Array(second.data))).toEqual([1, 2]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Buffer', () => Buffer.from([9, 1, 2, 9]).subarray(1, 3)],
    ['Uint16Array', () => new Uint16Array([9, 1, 2, 9]).subarray(1, 3)],
    ['DataView', () => new DataView(new Uint8Array([9, 1, 2, 9]).buffer, 1, 2)],
  ] as const)(
    'copies %s cache entries preserving the view type and visible bytes',
    async (_name, create) => {
      const original = create();
      const bytes = Array.from(
        new Uint8Array(original.buffer, original.byteOffset, original.byteLength),
      );
      const cache = {
        get: () => ({
          data: original,
          headers: {},
          status: 200,
          statusText: '',
          duration: 0,
          request: null,
        }),
        set: vi.fn(),
        delete: vi.fn(),
        clear: vi.fn(),
      };
      const client = corriere.create({ cache });
      const response = await client.get<typeof original>(url);
      expect(response.data.constructor).toBe(original.constructor);
      const result = new Uint8Array(
        response.data.buffer,
        response.data.byteOffset,
        response.data.byteLength,
      );
      expect(Array.from(result)).toEqual(bytes);
      result[0] = 99;
      expect(
        Array.from(new Uint8Array(original.buffer, original.byteOffset, original.byteLength)),
      ).toEqual(bytes);
    },
  );

  it('retains the explicit cacheClone false opt-out', async () => {
    const client = corriere.create({
      cache: true,
      cacheClone: false,
      responseType: 'arraybuffer',
      fetch: async () => new Response(new Uint8Array([1, 2])),
    });
    const first = await client.get<ArrayBuffer>(url);
    new Uint8Array(first.data)[0] = 99;
    const second = await client.get<ArrayBuffer>(url);
    expect(second.data).toBe(first.data);
    expect(new Uint8Array(second.data)[0]).toBe(99);
  });
});

describe('per-call transport overrides', () => {
  it.each(['fetch', 'dispatcher', 'agent'] as const)(
    'bypasses cache and dedupe when %s differs from the configured transport',
    async (field) => {
      const transportA = {};
      const transportB = {};
      const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        const transport = (init as RequestInit & { dispatcher?: unknown; agent?: unknown })?.[
          field as 'dispatcher' | 'agent'
        ];
        return json(transport === transportB ? 'B' : 'A');
      });
      const alternateFetch = vi.fn(async () => json('B'));
      const defaults: CorriereRequestConfig = { fetch, cache: true, dedupe: true };
      if (field !== 'fetch') defaults[field] = transportA;
      const client = corriere.create(defaults);
      await client.get(url); // Populate the default transport's cache.
      const override = { [field]: field === 'fetch' ? alternateFetch : transportB };
      const [a, b] = await Promise.all([client.get(url), client.get(url, override)]);
      expect(a.data).toBe('A');
      expect(b.data).toBe('B');
      expect((await client.get(url)).data).toBe('A');
      await client.get(url, override);
      expect(
        field === 'fetch' ? alternateFetch.mock.calls.length : fetch.mock.calls.length - 1,
      ).toBe(2);

      const [liveA, liveB] = await Promise.all([
        client.get(`${url}/uncached`),
        client.get(`${url}/uncached`, override),
      ]);
      expect(liveA.data).toBe('A');
      expect(liveB.data).toBe('B');
    },
  );
});

describe('pagination query precedence', () => {
  it('suppresses defaults across multiple next links without losing persistent filters', async () => {
    const seen: URL[] = [];
    const fetch = vi.fn(async (input: unknown) => {
      seen.push(new URL(String(input)));
      return json({
        items: [seen.length],
        next:
          seen.length === 1 ? `${url}?page=2&limit=5` : seen.length === 2 ? `${url}?page=3` : null,
      });
    });
    const defaults = Object.freeze({ page: 1, limit: 10, filter: 'active' });
    const config = Object.freeze({ category: 'books', page: 9 });
    const client = corriere.create({ params: defaults, fetch });
    const items = [];
    for await (const item of client.autoPaginate(url, { params: config })) items.push(item);
    expect(items).toEqual([1, 2, 3]);
    expect(seen.map((u) => u.searchParams.getAll('page'))).toEqual([['9'], ['2'], ['3']]);
    expect(seen.map((u) => u.searchParams.getAll('limit'))).toEqual([['10'], ['5'], []]);
    for (const u of seen) {
      expect(u.searchParams.getAll('filter')).toEqual(['active']);
      expect(u.searchParams.getAll('category')).toEqual(['books']);
    }
    expect(client.defaults.params).toEqual(defaults);
    expect(config).toEqual({ category: 'books', page: 9 });
  });
  it('passes custom serializers only the remaining persistent parameters', async () => {
    const serialized: Record<string, unknown>[] = [];
    const seen: URL[] = [];
    const client = corriere.create({
      params: { page: 1, filter: 'active' },
      paramsSerializer(params) {
        serialized.push({ ...params });
        return Object.entries(params)
          .map(([k, v]) => `${k}=${v}`)
          .join('&');
      },
      fetch: async (input) => {
        seen.push(new URL(String(input)));
        return json({ items: [], next: seen.length === 1 ? `${url}?page=2` : null });
      },
    });
    for await (const _ of client.autoPaginate(url)) {
      /* drain */
    }
    expect(serialized).toEqual([{ page: 1, filter: 'active' }, { filter: 'active' }]);
    expect(seen[1].searchParams.getAll('page')).toEqual(['2']);
  });
});
