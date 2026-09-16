import { beforeEach, describe, expect, it, vi } from 'vitest';
import dispatchRequest from '../src/core/request';

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('config.fetch (custom fetch injection)', () => {
  it('uses config.fetch instead of the global fetch when provided', async () => {
    const globalFetch = vi.fn(() => Promise.resolve(jsonResponse({ from: 'global' })));
    global.fetch = globalFetch as any;

    const customFetch = vi.fn(() => Promise.resolve(jsonResponse({ from: 'custom' })));

    const response = await dispatchRequest({
      url: 'https://api.test.com/x',
      method: 'get',
      fetch: customFetch as any,
    });

    expect(customFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(response.data).toEqual({ from: 'custom' });
  });
});

describe('config.cacheKeySerializer', () => {
  it('is invoked to build the cache key instead of the default builder', async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse({ v: 1 }))) as any;

    const serializer = vi.fn(() => 'fixed-key');
    const cache = new Map<string, unknown>();
    const cacheProvider = {
      get: async (key: string) => cache.get(key),
      set: async (key: string, value: unknown) => {
        cache.set(key, value);
      },
    };

    await dispatchRequest({
      url: 'https://api.test.com/a',
      method: 'get',
      cache: cacheProvider as any,
      cacheKeySerializer: serializer,
    });

    expect(serializer).toHaveBeenCalled();
    expect(cache.has('fixed-key')).toBe(true);

    // A different URL that serializes to the same fixed key hits the same cache entry.
    (global.fetch as any).mockClear();
    const second = await dispatchRequest({
      url: 'https://api.test.com/completely-different',
      method: 'get',
      cache: cacheProvider as any,
      cacheKeySerializer: serializer,
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(second.data).toEqual({ v: 1 });
  });
});

describe('config.dispatcher / config.agent pass-through', () => {
  it('forwards dispatcher and agent onto the fetch RequestInit', async () => {
    const dispatcher = { name: 'my-dispatcher' };
    const agent = { name: 'my-agent' };
    const capturedOptions: RequestInit[] = [];

    global.fetch = vi.fn((_url: string, options: RequestInit) => {
      capturedOptions.push(options);
      return Promise.resolve(jsonResponse({ ok: true }));
    }) as any;

    await dispatchRequest({
      url: 'https://api.test.com/x',
      method: 'get',
      dispatcher,
      agent,
    });

    expect((capturedOptions[0] as any).dispatcher).toBe(dispatcher);
    expect((capturedOptions[0] as any).agent).toBe(agent);
  });
});

describe('fetchAdapter JSON parse failure guard', () => {
  beforeEach(() => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response('not valid json{{{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ) as any;
  });

  it('throws ERR_BAD_RESPONSE with a raw-body preview when content-type is application/json but the body is not valid JSON', async () => {
    await expect(
      dispatchRequest({ url: 'https://api.test.com/x', method: 'get' }),
    ).rejects.toMatchObject({
      code: 'ERR_BAD_RESPONSE',
      message: expect.stringContaining('Failed to parse JSON response'),
    });
  });
});

describe('opaqueredirect handling (config.maxRedirects in an unsupported environment)', () => {
  it('throws ERR_NOT_SUPPORT when the fetch implementation returns an opaque redirect', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        type: 'opaqueredirect',
        status: 0,
        ok: false,
        headers: new Headers(),
        body: null,
      } as unknown as Response),
    ) as any;

    await expect(
      dispatchRequest({
        url: 'https://api.test.com/x',
        method: 'get',
        maxRedirects: 5,
      }),
    ).rejects.toMatchObject({
      code: 'ERR_NOT_SUPPORT',
      message: expect.stringContaining('opaque redirect'),
    });
  });
});
