import { describe, expect, it, vi } from 'vitest';
import { redactURL } from '../src/core/corriereError';
import mergeConfig from '../src/core/mergeConfig';
import { logError } from '../src/helpers/debug';
import corriere from '../src/index';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

describe('request configuration ownership', () => {
  it('isolates library defaults between clients', () => {
    const first = corriere.create();
    const second = corriere.create();
    expect(first.defaults.headers).not.toBe(second.defaults.headers);
    first.defaults.headers!.common!['X-Private'] = 'first';
    expect(second.defaults.headers!.common!['X-Private']).toBeUndefined();
    expect(corriere.defaults.headers!.common!['X-Private']).toBeUndefined();
  });

  it('isolates concurrent interceptor changes and nested arrays from defaults and caller config', async () => {
    const supplied = {
      headers: { common: { 'X-Labels': ['original'] } },
      params: { filters: [{ name: 'original' }] },
    };
    const seen: string[] = [];
    const client = corriere.create({
      ...supplied,
      fetch: async (_url, options) => {
        seen.push(new Headers(options?.headers).get('X-Labels')!);
        return json({});
      },
    });
    client.interceptors.request.use(async (config) => {
      if (config.url!.endsWith('/first')) {
        (config.headers!.common!['X-Labels'] as string[]).push('first');
        (config.params!.filters as { name: string }[])[0].name = 'first';
        await Promise.resolve();
      }
      return config;
    });
    await Promise.all([
      client.get('https://example.test/first'),
      client.get('https://example.test/second'),
    ]);
    expect(seen).toContain('original, first');
    expect(seen).toContain('original');
    expect(client.defaults.params).toEqual({ filters: [{ name: 'original' }] });
    expect(supplied.headers.common['X-Labels']).toEqual(['original']);
    expect(supplied.params.filters[0].name).toBe('original');
  });

  it('copies hook containers while preserving providers, schemas and transport identities', () => {
    const fetch = vi.fn();
    const cache = { get: vi.fn(), set: vi.fn(), delete: vi.fn(), clear: vi.fn() };
    const schema = { parse: vi.fn() };
    const hooks = { onBeforeRequest: vi.fn() };
    const config = mergeConfig({ fetch, cache, schema, hooks });
    expect(config.hooks).not.toBe(hooks);
    expect(config.hooks!.onBeforeRequest).toBe(hooks.onBeforeRequest);
    expect(config.cache).toBe(cache);
    expect(config.schema).toBe(schema);
    expect(config.fetch).toBe(fetch);
  });

  it('preserves non-plain parameter values', () => {
    const params = new URLSearchParams('page=2');
    expect(mergeConfig({}, { params: params as never }).params).toBeInstanceOf(URLSearchParams);
  });
});

describe('inherited header removal', () => {
  it.each([
    { Authorization: undefined },
    { authorization: undefined },
    { common: { authorization: undefined } },
    { get: { authorization: undefined } },
  ])('removes an inherited common header with %j', async (headers) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({}));
    const client = corriere.create({
      headers: { common: { Authorization: 'Bearer secret' } },
      fetch,
    });
    await client.get('https://example.test', { headers });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false);
    expect(client.defaults.headers!.common!.Authorization).toBe('Bearer secret');
  });

  it('removes a flat inherited header and does not revive a common fallback', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json({}));
    const client = corriere.create({
      headers: { common: { Authorization: 'fallback' }, Authorization: 'flat' },
      fetch,
    });
    await client.get('https://example.test', { headers: { authorization: undefined } });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).has('authorization')).toBe(false);
  });
});

describe('safe request diagnostics', () => {
  it.each(['{"password":"audit-secret"}', 'password=audit-secret', 'audit-secret'])(
    'omits opaque string bodies from serialized error configs',
    async (data) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => json({}, 400));
      const client = corriere.create({ fetch });
      const error = await client.post('https://example.test', data).catch((e) => e);
      expect(
        JSON.stringify({ error, config: error.config, response: error.response }),
      ).not.toContain('audit-secret');
      expect(error.config.data).toBe('[REDACTED]');
      expect(fetch.mock.calls[0][1]?.body).toBe(data);
    },
  );

  it('preserves string bodies on successful response configs', async () => {
    const data = '{"password":"caller-owned"}';
    const client = corriere.create({ fetch: async () => json({}) });
    expect((await client.post('https://example.test', data)).config.data).toBe(data);
  });

  it('redacts arrays and bracketed query keys in configs and request logs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const params = {
        filter: [{ password: 'array-secret', label: 'public' }],
        'filter[token]': 'bracket-secret',
      };
      const client = corriere.create({ debug: true, fetch: async () => json({}, 400) });
      const error = await client.get('https://example.test', { params }).catch((e) => e);
      const output = JSON.stringify({ error, response: error.response, logs: log.mock.calls });
      expect(output).not.toContain('array-secret');
      expect(output).not.toContain('bracket-secret');
      expect(error.config.params.filter[0].label).toBe('public');
      expect(params.filter[0].password).toBe('array-secret');
    } finally {
      log.mockRestore();
    }
  });

  it('redacts encoded nested query keys without changing unrelated values', () => {
    expect(redactURL('/items?filter%5B0%5D%5Bpassword%5D=secret&sort=name')).toBe(
      '/items?filter%5B0%5D%5Bpassword%5D=[REDACTED]&sort=name',
    );
  });

  it('redacts invalid URLs and redirect locations in messages', async () => {
    const client = corriere.create();
    const error = await client.get('http://[invalid]?token=url-secret').catch((e) => e);
    expect(error.code).toBe('ERR_INVALID_URL');
    expect(error.message).not.toContain('url-secret');
    const redirect = corriere.create({
      maxRedirects: 1,
      fetch: async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://[invalid]?token=redirect-secret' },
        }),
    });
    const redirectError = await redirect.get('https://example.test').catch((e) => e);
    expect(redirectError.code).toBe('ERR_INVALID_URL');
    expect(redirectError.message).not.toContain('redirect-secret');
  });

  it('redacts pagination cycle messages', async () => {
    const client = corriere.create({
      fetch: async () => json({ items: [], next: 'https://example.test/items?token=cycle-secret' }),
    });
    await expect(
      (async () => {
        for await (const _ of client.autoPaginate(
          'https://example.test/items?token=cycle-secret',
        )) {
        }
      })(),
    ).rejects.toMatchObject({
      code: 'ERR_BAD_RESPONSE',
      message: expect.not.stringContaining('cycle-secret'),
    });
  });

  it.each(['original reason', null, undefined, 42])(
    'preserves a non-Error rejection with debug enabled: %s',
    async (reason) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const client = corriere.create({ debug: true });
        client.interceptors.request.use(() => {
          throw reason;
        });
        await expect(client.get('https://example.test')).rejects.toBe(reason);
      } finally {
        log.mockRestore();
      }
    },
  );

  it('never lets a failing console or error getter replace a request outcome', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('broken logger');
    });
    try {
      const client = corriere.create({ debug: true, fetch: async () => json({ ok: true }) });
      await expect(client.get('https://example.test')).resolves.toMatchObject({
        data: { ok: true },
      });
      client.interceptors.request.use(() => {
        throw 'original failure';
      });
      await expect(client.get('https://example.test')).rejects.toBe('original failure');
      expect(() =>
        logError(
          Object.defineProperty({}, 'message', {
            get() {
              throw new Error('getter');
            },
          }),
          { debug: true },
        ),
      ).not.toThrow();
    } finally {
      log.mockRestore();
    }
  });
});
