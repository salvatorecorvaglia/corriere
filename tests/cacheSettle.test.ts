import { beforeEach, describe, expect, it, vi } from 'vitest';
import dispatchRequest from '../src/core/request';
import Corriere from '../src/corriere';
import { MemoryCache } from '../src/helpers/memoryCache';

/**
 * The cache used to be written before `settle()` ran, and cache hits skipped `settle()`
 * entirely. A 500 was therefore stored and replayed to later callers as a *resolved*
 * success, bypassing `validateStatus` completely.
 */
describe('cache interaction with validateStatus', () => {
  let cache: MemoryCache;
  let fetchCalls: number;
  const ok2xx = (status: number) => status >= 200 && status < 300;

  function serve(status: number, body: Record<string, unknown> = { ok: true }) {
    fetchCalls = 0;
    global.fetch = vi.fn(() => {
      fetchCalls++;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as any;
  }

  const req = (extra: Record<string, unknown> = {}) => ({
    url: 'https://api.test.com/thing',
    method: 'get',
    cache,
    validateStatus: ok2xx,
    ...extra,
  });

  beforeEach(() => {
    cache = new MemoryCache();
    fetchCalls = 0;
  });

  /**
   * `applySchema` mutates `settled.data` in place, and the cache write used to run after
   * it. A schema that reshapes its input therefore wrote its *output* into a cache shared
   * with callers who passed no schema at all, handing them a shape they never asked for.
   * The cache stores what the server sent; each reader applies its own schema on the way
   * out.
   */
  it('caches the server’s data, not a schema’s transformed output', async () => {
    serve(200, { value: 42 });

    const reshaping = {
      parse: (data: any) => ({ reshaped: true, original: data }),
    };

    const withSchema = await dispatchRequest(req({ schema: reshaping }));
    expect(withSchema.data).toEqual({ reshaped: true, original: { value: 42 } });

    // Same URL and headers, so the same cache key — but no schema this time.
    const withoutSchema = await dispatchRequest(req());
    expect(fetchCalls).toBe(1);
    expect(withoutSchema.data).toEqual({ value: 42 });
  });

  it('re-applies each caller’s own schema to a cache hit', async () => {
    serve(200, { value: 42 });

    await dispatchRequest(req());
    expect(fetchCalls).toBe(1);

    const strict = {
      parse: (data: any) => {
        if ((data as any).value !== 1) throw new Error('expected value 1');
        return data;
      },
    };
    await expect(dispatchRequest(req({ schema: strict }))).rejects.toMatchObject({
      code: 'ERR_BAD_RESPONSE',
    });
    // Still served from cache — the rejection came from the schema, not a second request.
    expect(fetchCalls).toBe(1);
  });

  it('does not cache a 500', async () => {
    serve(500);
    await expect(dispatchRequest(req())).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE' });
    await expect(dispatchRequest(req())).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE' });
    // Both calls must reach the network; nothing was stored.
    expect(fetchCalls).toBe(2);
  });

  it('does not cache a 404', async () => {
    serve(404);
    await expect(dispatchRequest(req())).rejects.toMatchObject({ code: 'ERR_BAD_REQUEST' });
    await expect(dispatchRequest(req())).rejects.toMatchObject({ code: 'ERR_BAD_REQUEST' });
    expect(fetchCalls).toBe(2);
  });

  it('still caches a 200', async () => {
    serve(200, { value: 42 });
    const first = await dispatchRequest(req());
    const second = await dispatchRequest(req());
    expect(fetchCalls).toBe(1);
    expect((first.data as any).value).toBe(42);
    expect((second.data as any).value).toBe(42);
  });

  it('applies validateStatus to a replayed cache hit', async () => {
    serve(299);
    // Stored under a permissive validateStatus...
    await dispatchRequest(req({ validateStatus: ok2xx }));
    expect(fetchCalls).toBe(1);

    // ...and rejected when a later caller tightens it, rather than resolving blindly.
    await expect(
      dispatchRequest(req({ validateStatus: (s: number) => s === 200 })),
    ).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE' });
  });

  it('a custom validateStatus that accepts 500 caches it as a success', async () => {
    serve(500);
    const permissive = req({ validateStatus: () => true });
    const first = await dispatchRequest(permissive);
    const second = await dispatchRequest(permissive);
    expect(first.status).toBe(500);
    expect(second.status).toBe(500);
    expect(fetchCalls).toBe(1);
  });

  it('applies config.schema to a replayed cache hit, not just the call that populated it', async () => {
    serve(200, { id: 1 });
    // Populated without a schema...
    await dispatchRequest(req());
    expect(fetchCalls).toBe(1);

    // ...and a later caller's schema is still enforced against the cached data.
    const schema = { parse: vi.fn((data: any) => ({ ...data, parsed: true })) };
    const second = await dispatchRequest(req({ schema }));
    expect(schema.parse).toHaveBeenCalled();
    expect((second.data as any).parsed).toBe(true);
    expect(fetchCalls).toBe(1);
  });

  it('rejects a cache hit whose schema fails, without hitting the network again', async () => {
    serve(200, { id: 1 });
    await dispatchRequest(req());
    expect(fetchCalls).toBe(1);

    const failingSchema = {
      parse: vi.fn(() => {
        throw new Error('Validation failed');
      }),
    };
    await expect(dispatchRequest(req({ schema: failingSchema }))).rejects.toMatchObject({
      isCorriereError: true,
      code: 'ERR_BAD_RESPONSE',
    });
    expect(fetchCalls).toBe(1);
  });

  it('invokes hooks.onRequestError when a cache hit fails validateStatus', async () => {
    serve(299);
    await dispatchRequest(req({ validateStatus: ok2xx }));
    expect(fetchCalls).toBe(1);

    const onRequestError = vi.fn();
    await expect(
      dispatchRequest(
        req({
          validateStatus: (s: number) => s === 200,
          hooks: { onRequestError },
        }),
      ),
    ).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE' });
    expect(onRequestError).toHaveBeenCalledTimes(1);
    expect(onRequestError.mock.calls[0][0]).toMatchObject({ code: 'ERR_BAD_RESPONSE' });
  });

  it('invokes hooks.onRequestResponse on a cache hit that resolves', async () => {
    serve(200, { id: 1 });
    await dispatchRequest(req());
    expect(fetchCalls).toBe(1);

    const onRequestResponse = vi.fn();
    await dispatchRequest(req({ hooks: { onRequestResponse } }));
    expect(onRequestResponse).toHaveBeenCalledTimes(1);
  });
});

describe('response cloning is scoped to shared values', () => {
  beforeEach(() => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ nested: { n: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ) as any;
  });

  it('does not deep-clone when neither cache nor dedupe is enabled', async () => {
    const spy = vi.spyOn(globalThis, 'structuredClone');
    await dispatchRequest({ url: 'https://api.test.com/plain', method: 'get' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('isolates a cached entry from later mutation of the returned response', async () => {
    const cache = new MemoryCache();
    const first = await dispatchRequest({
      url: 'https://api.test.com/mutate',
      method: 'get',
      cache,
      validateStatus: (s: number) => s < 300,
    });
    (first.data as any).nested.n = 999;

    const second = await dispatchRequest({
      url: 'https://api.test.com/mutate',
      method: 'get',
      cache,
      validateStatus: (s: number) => s < 300,
    });
    expect((second.data as any).nested.n).toBe(1);
  });
});

describe('cacheClone option support', () => {
  it('returns a clone by default but returns the same reference when cacheClone is false', async () => {
    const client = new Corriere();
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve('{"items": [1]}'),
    });

    // Default (cloning enabled)
    const res1 = await client.request({ url: '/cache-test', cache: true });
    const res2 = await client.request({ url: '/cache-test', cache: true });
    expect(res1.data).not.toBe(res2.data);
    expect(res1.data).toEqual(res2.data);

    // cacheClone: false (cloning disabled)
    const res3 = await client.request({
      url: '/cache-test-no-clone',
      cache: true,
      cacheClone: false,
    });
    const res4 = await client.request({
      url: '/cache-test-no-clone',
      cache: true,
      cacheClone: false,
    });
    expect(res3.data).toBe(res4.data);
  });
});

describe('Cache response data mutations protection', () => {
  it('returns a separate clone from MemoryCache to prevent shared object mutation side-effects', async () => {
    const client = new Corriere();

    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve('{"items": [1, 2]}'),
    });

    // First request (populates cache)
    const res1 = await client.request({
      url: '/cached',
      cache: true,
    });

    expect(res1.data).toEqual({ items: [1, 2] });

    // Mutate returned object
    (res1.data as any).items.push(3);

    // Second request (hits cache)
    const res2 = await client.request({
      url: '/cached',
      cache: true,
    });

    // Verify cached entry was not mutated
    expect(res2.data).toEqual({ items: [1, 2] });
  });
});
