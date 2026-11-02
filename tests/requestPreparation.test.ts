import { afterEach, describe, expect, it, vi } from 'vitest';
import corriere from '../src/index';
import type { CorriereRequestConfig, TransformFunction } from '../src/types';

afterEach(() => vi.restoreAllMocks());
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const url = 'https://example.test/items';

describe('request preparation', () => {
  it('accepts templated bases while enforcing their resolved path boundary', async () => {
    const fetch = vi.fn(async (input: unknown) => json(String(input)));
    const paramsSerializer = vi.fn(() => 'q=1');
    const client = corriere.create({
      baseURL: 'https://example.test/v1/{tenant}',
      fetch,
      paramsSerializer,
    });
    expect((await client.get('/items', { params: { tenant: 'acme' } })).data).toBe(
      'https://example.test/v1/acme/items?q=1',
    );
    expect(paramsSerializer).toHaveBeenCalledTimes(1);
    await expect(client.get('../admin', { params: { tenant: 'acme' } })).rejects.toMatchObject({
      code: 'ERR_BAD_OPTION',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('uses hook URL, baseURL, and params changes for transport, logging, and cache keys', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const serializer = vi.fn((params: Record<string, unknown>) => `q=${params.q}`);
    const cacheKeySerializer = vi.fn((_config, finalURL) => finalURL);
    const fetch = vi.fn(async (input: unknown) => json(String(input)));
    const client = corriere.create({
      baseURL: 'https://example.test/v1',
      fetch,
      cache: true,
      debug: true,
      paramsSerializer: serializer,
      cacheKeySerializer,
      hooks: {
        async onBeforeRequest(config) {
          config.baseURL = 'https://example.test/v2';
          config.url = '/ready/{id}';
          config.params = { id: 2, q: 'final' };
        },
      },
    });
    expect((await client.get('/original')).data).toBe('https://example.test/v2/ready/2?q=final');
    expect(serializer).toHaveBeenCalledTimes(1);
    expect(cacheKeySerializer.mock.calls[0][1]).toBe('https://example.test/v2/ready/2?q=final');
    const requestLog = log.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes('→'));
    expect(requestLog).toContain('https://example.test/v2/ready/2?q=final');
    expect(requestLog).not.toContain('/original');
  });

  it.each(['cache', 'dedupe'] as const)(
    'separates transformed credentials for %s',
    async (feature) => {
      const fetch = vi.fn(async (_input: unknown, options?: RequestInit) =>
        json(new Headers(options?.headers).get('authorization')),
      );
      const client = corriere.create({ fetch, [feature]: true });
      const transformA = vi.fn<TransformFunction>(async (data, headers) => {
        headers.Authorization = 'Bearer A';
        return data;
      });
      const transformB = vi.fn<TransformFunction>(async (data, headers) => {
        headers.Authorization = 'Bearer B';
        return data;
      });
      const firstRequest = client.get(url, { transformRequest: transformA });
      if (feature === 'cache') await firstRequest;
      const secondRequest = client.get(url, { transformRequest: transformB });
      const [first, second] = await Promise.all([firstRequest, secondRequest]);
      expect(first.data).toBe('Bearer A');
      expect(second.data).toBe('Bearer B');
      expect(fetch).toHaveBeenCalledTimes(2);
      if (feature === 'cache') {
        expect((await client.get(url, { transformRequest: transformA })).data).toBe('Bearer A');
        expect(transformA).toHaveBeenCalledTimes(2);
        expect(fetch).toHaveBeenCalledTimes(2);
      }
    },
  );

  it.each(['cache', 'dedupe'] as const)(
    'shares identical final headers for %s and prepares every caller once',
    async (feature) => {
      const fetch = vi.fn(async () => json('shared'));
      const transform = vi.fn<TransformFunction>(async (data, headers) => {
        headers['X-Tenant'] = 'normalized';
        return data;
      });
      const hook = vi.fn();
      const client = corriere.create({
        fetch,
        [feature]: true,
        transformRequest: transform,
        hooks: { onBeforeRequest: hook },
      });
      const first = client.get(url, {
        headers: { 'X-Tenant': 'first', 'Content-Type': 'ignored' },
      });
      if (feature === 'cache') await first;
      const second = client.get(url, { headers: { 'X-Tenant': 'second' } });
      expect((await Promise.all([first, second])).map((response) => response.data)).toEqual([
        'shared',
        'shared',
      ]);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(transform).toHaveBeenCalledTimes(2);
      expect(hook).toHaveBeenCalledTimes(2);
    },
  );

  it('resolves transform URL changes and gives custom serializers transformed headers', async () => {
    const fetch = vi.fn(async (input: unknown) => json(String(input)));
    const serializer = vi.fn((_config, finalURL, headers) => `${finalURL}:${headers['X-Tenant']}`);
    const client = corriere.create({
      fetch,
      cache: true,
      cacheKeySerializer: serializer,
      transformRequest: async (data, headers, config) => {
        config.url = 'https://example.test/transformed';
        config.params = { page: 2 };
        headers['X-Tenant'] = 'final';
        return data;
      },
    });
    expect((await client.get(url)).data).toBe('https://example.test/transformed?page=2');
    expect(serializer.mock.calls[0][1]).toBe('https://example.test/transformed?page=2');
    expect(serializer.mock.calls[0][2]).toMatchObject({ 'X-Tenant': 'final' });
  });

  it.each(['protocol', 'base path'])(
    'validates final %s before cache lookup or transport',
    async (boundary) => {
      const get = vi.fn();
      const fetch = vi.fn();
      const errorHook = vi.fn();
      const client = corriere.create({
        fetch,
        baseURL: boundary === 'base path' ? 'https://example.test/v1' : undefined,
        cache: { get, set: vi.fn(), delete: vi.fn(), clear: vi.fn() },
        hooks: {
          onBeforeRequest(config) {
            config.url = boundary === 'protocol' ? 'file:///private' : '../admin';
          },
          onRequestError: errorHook,
        },
      });
      await expect(client.get(boundary === 'protocol' ? url : '/valid')).rejects.toMatchObject({
        code: 'ERR_BAD_OPTION',
      });
      expect(get).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(errorHook).toHaveBeenCalledTimes(1);
    },
  );

  it('prepares each retry once using fresh hook URL and transform results', async () => {
    let attempt = 0;
    const urls: string[] = [];
    const fetch = vi.fn(async (input: unknown) => {
      urls.push(String(input));
      return json('result', urls.length === 1 ? 503 : 200);
    });
    const transform = vi.fn<TransformFunction>(async (data) => data);
    const client = corriere.create({
      fetch,
      retry: 1,
      retryDelay: 0,
      transformRequest: transform,
      hooks: {
        onBeforeRequest(config) {
          config.params = { page: ++attempt };
        },
      },
    });
    await client.get(url);
    expect(urls).toEqual([`${url}?page=1`, `${url}?page=2`]);
    expect(transform).toHaveBeenCalledTimes(2);
  });

  it('invalidates using final URL and header values without running preparation again', async () => {
    const fetch = vi.fn(async () => json('result'));
    const hook = vi.fn((config: CorriereRequestConfig) => {
      config.url = url;
    });
    const transform = vi.fn<TransformFunction>(async (data, headers) => {
      headers.Authorization = 'Bearer final';
      return data;
    });
    const client = corriere.create({
      fetch,
      cache: true,
      hooks: { onBeforeRequest: hook },
      transformRequest: transform,
    });
    await client.get('https://example.test/original');
    client.invalidate(url, { headers: { Authorization: 'Bearer final' } });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(transform).toHaveBeenCalledTimes(1);
    await client.get('https://example.test/original');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('strips credentials reattached by transforms on cross-origin pagination', async () => {
    const auth: (string | null)[] = [];
    const client = corriere.create({
      allowedPaginateHosts: ['other.test'],
      transformRequest: async (data, headers) => {
        headers.Authorization = 'Bearer private';
        headers.Cookie = 'session=private';
        return data;
      },
      fetch: async (_input, options) => {
        const headers = new Headers(options?.headers);
        auth.push(headers.get('authorization'), headers.get('cookie'));
        return json({ items: [], next: auth.length === 2 ? 'https://other.test/next' : null });
      },
    });
    for await (const _ of client.autoPaginate(url)) {
      /* drain */
    }
    expect(auth).toEqual(['Bearer private', 'session=private', null, null]);
  });
});
