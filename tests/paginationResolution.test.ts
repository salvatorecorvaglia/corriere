import { describe, expect, it, vi } from 'vitest';
import corriere, { type CorriereInstance, type CorriereRequestConfig } from '../src/index';

async function collect(client: CorriereInstance, url: string, config?: CorriereRequestConfig) {
  const items = [];
  for await (const item of client.autoPaginate(url, config)) items.push(item);
  return items;
}

function pages(next: unknown, extra: CorriereRequestConfig = {}) {
  const seen: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    seen.push(String(input));
    return new Response(
      JSON.stringify({ items: [seen.length], next: seen.length === 1 ? next : null }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  return { seen, fetch, client: corriere.create({ ...extra, fetch }) };
}

describe('pagination link resolution', () => {
  it('preserves relative-only transports without inventing an origin', async () => {
    const { client, seen } = pages('?page=2');
    await collect(client, '/items');
    const expected =
      typeof location === 'undefined'
        ? '/items?page=2'
        : new URL('/items?page=2', location.href).href;
    expect(seen).toEqual(['/items', expected]);
  });

  it('treats fragment-only links as cycles before issuing another request', async () => {
    const { client, fetch } = pages('#next');
    await expect(collect(client, 'https://example.test/items')).rejects.toMatchObject({
      code: 'ERR_BAD_RESPONSE',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('resolves relative links after manual redirects with empty mock response URLs', async () => {
    const seen: string[] = [];
    const client = corriere.create({
      maxRedirects: 2,
      fetch: async (input) => {
        seen.push(String(input));
        if (seen.length === 1)
          return new Response(null, { status: 302, headers: { location: '/moved/items' } });
        return new Response(
          JSON.stringify({ items: [], next: seen.length === 2 ? '?page=2' : null }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });
    await collect(client, 'https://example.test/original');
    expect(seen).toEqual([
      'https://example.test/original',
      'https://example.test/moved/items',
      'https://example.test/moved/items?page=2',
    ]);
  });

  it('keeps the original origin as the credential boundary after a cross-origin redirect', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const client = corriere.create({
      headers: { Authorization: 'secret' },
      maxRedirects: 2,
      allowedPaginateHosts: ['other.test'],
      fetch: async (input, init) => {
        seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
        if (seen.length === 1)
          return new Response(null, {
            status: 302,
            headers: { location: 'https://other.test/items' },
          });
        return new Response(
          JSON.stringify({ items: [], next: seen.length === 2 ? '?page=2' : null }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });
    await collect(client, 'https://example.test/original');
    expect(seen).toEqual([
      { url: 'https://example.test/original', auth: 'secret' },
      { url: 'https://other.test/items', auth: null },
      { url: 'https://other.test/items?page=2', auth: null },
    ]);
  });

  it('redacts malformed initial URLs through the request pipeline', async () => {
    const { client, fetch } = pages(null);
    await expect(collect(client, 'http://[invalid]?token=secret')).rejects.toMatchObject({
      code: 'ERR_INVALID_URL',
      message: expect.not.stringContaining('secret'),
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['?page=2', 'https://example.test/api/items?page=2'],
    ['next?page=2', 'https://example.test/api/next?page=2'],
    ['../next?page=2', 'https://example.test/next?page=2'],
    ['/root?page=2', 'https://example.test/root?page=2'],
  ])('resolves %s against the current resource URL', async (next, expected) => {
    const { client, seen } = pages(next, { baseURL: 'https://example.test/api' });
    expect(await collect(client, '/items')).toEqual([1, 2]);
    expect(seen).toEqual(['https://example.test/api/items', expected]);
  });

  it('resolves relative links without an instance baseURL', async () => {
    const { client, seen } = pages('?page=2');
    await collect(client, 'https://example.test/api/items');
    expect(seen[1]).toBe('https://example.test/api/items?page=2');
  });

  it('uses the effective redirected response URL for relative links', async () => {
    const { client, seen, fetch } = pages('?page=2');
    fetch.mockImplementationOnce(async (input) => {
      seen.push(String(input));
      const response = new Response(JSON.stringify({ items: [1], next: '?page=2' }), {
        headers: { 'content-type': 'application/json' },
      });
      Object.defineProperty(response, 'url', { value: 'https://example.test/moved/items?page=1' });
      return response;
    });
    await collect(client, 'https://example.test/api/items');
    expect(seen[1]).toBe('https://example.test/moved/items?page=2');
  });

  it('uses a request hook’s final URL as the fallback when a mock response has no URL', async () => {
    const { client, seen } = pages('?page=2');
    client.interceptors.request.use((config) => {
      if (config.url === 'https://example.test/original')
        config.url = 'https://example.test/moved/items';
      return config;
    });
    await collect(client, 'https://example.test/original');
    expect(seen[1]).toBe('https://example.test/moved/items?page=2');
  });

  it('follows a protocol-relative allowed host and strips credentials', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const client = corriere.create({
      baseURL: 'https://example.test/api',
      headers: { Authorization: 'secret' },
      allowedPaginateHosts: ['other.test'],
      fetch: async (input, init) => {
        seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
        return new Response(
          JSON.stringify({ items: [], next: seen.length === 1 ? '//other.test/items' : null }),
          { headers: { 'content-type': 'application/json' } },
        );
      },
    });
    await collect(client, '/items');
    expect(seen).toEqual([
      { url: 'https://example.test/api/items', auth: 'secret' },
      { url: 'https://other.test/items', auth: null },
    ]);
  });

  it('rejects an unapproved protocol-relative host before another transport call', async () => {
    const { client, fetch } = pages('//other.test/items', { baseURL: 'https://example.test/api' });
    await expect(collect(client, '/items')).rejects.toMatchObject({ code: 'ERR_BAD_OPTION' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('detects cycles in query-only links including initial params', async () => {
    const { client, fetch } = pages('?page=1', { params: { page: 1 } });
    await expect(collect(client, 'https://example.test/items')).rejects.toMatchObject({
      code: 'ERR_BAD_RESPONSE',
      message: expect.stringContaining('cycle'),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, null, '2'])(
    'rejects invalid maxPages=%s before fetching',
    async (maxPages) => {
      const { client, fetch } = pages(null);
      await expect(
        collect(client, 'https://example.test/items', { maxPages: maxPages as number }),
      ).rejects.toMatchObject({ code: 'ERR_BAD_OPTION_VALUE' });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(
    [
      42,
      {},
      ['?page=2'],
      'http://[invalid]?token=secret',
      'https://user:secret@example.test/items',
    ].map((next) => ({ next })),
  )('rejects an invalid next link without leaking it: $next', async ({ next }) => {
    const { client, fetch } = pages(next);
    await expect(collect(client, 'https://example.test/items')).rejects.toMatchObject({
      code: 'ERR_BAD_RESPONSE',
      message: expect.not.stringContaining('secret'),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
