import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dispatchRequest from '../src/core/request';
import retryRequest from '../src/core/retry';
import Corriere from '../src/corriere';
import { MemoryCache } from '../src/helpers/memoryCache';

/**
 * Delivery to dedupe subscribers. The fan-out is the one place where a single adapter
 * response is split across several callers with independent configs, transforms, schemas
 * and hooks, so one caller's misbehaviour must not be able to affect another's outcome.
 */
describe('dedupe fan-out', () => {
  let fetchCalls: number;

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

  // `dispatchRequest` is the bare pipeline — `defaults` (and with it `validateStatus`) is
  // applied by `Corriere.request`, so these direct-dispatch tests supply it themselves.
  const ok2xx = (status: number) => status >= 200 && status < 300;

  const req = (extra: Record<string, unknown> = {}) => ({
    url: 'https://api.test.com/shared',
    method: 'get',
    dedupe: true,
    validateStatus: ok2xx,
    ...extra,
  });

  beforeEach(() => {
    fetchCalls = 0;
  });

  describe('a broken onRequestError hook', () => {
    let unhandled: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      unhandled = vi.fn();
      process.on('unhandledRejection', unhandled as unknown as NodeJS.UnhandledRejectionListener);
    });

    afterEach(() => {
      process.off('unhandledRejection', unhandled as unknown as NodeJS.UnhandledRejectionListener);
    });

    /**
     * The shared promise rejecting (a network error — *not* an error status, which
     * resolves out of fetch and fails later per-subscriber) runs the reject-branch
     * fan-out. That branch used to call the hook bare, guarding only the async case with
     * `hookResult.catch(...)`. A hook that threw synchronously escaped the delivery loop:
     * it became an unhandled rejection, and every subscriber queued behind the throwing
     * one never settled at all.
     */
    it('does not strand the other subscribers when one hook throws synchronously', async () => {
      fetchCalls = 0;
      global.fetch = vi.fn(() => {
        fetchCalls++;
        return Promise.reject(new TypeError('fetch failed'));
      }) as any;

      const throwingHook = vi.fn(() => {
        throw new Error('sync boom');
      });
      const laterHookA = vi.fn();
      const laterHookB = vi.fn();

      const settledInTime = await Promise.race([
        Promise.allSettled([
          dispatchRequest(req({ hooks: { onRequestError: throwingHook } })),
          dispatchRequest(req({ hooks: { onRequestError: laterHookA } })),
          dispatchRequest(req({ hooks: { onRequestError: laterHookB } })),
        ]),
        // Before the fix the subscribers behind the throwing hook never settled at all,
        // so the assertions below would hang rather than fail. Bound the wait.
        new Promise((resolve) => setTimeout(() => resolve('timed out'), 250)),
      ]);

      expect(settledInTime).not.toBe('timed out');
      expect((settledInTime as PromiseSettledResult<unknown>[]).map((r) => r.status)).toEqual([
        'rejected',
        'rejected',
        'rejected',
      ]);
      expect(throwingHook).toHaveBeenCalledTimes(1);
      expect(laterHookA).toHaveBeenCalledTimes(1);
      expect(laterHookB).toHaveBeenCalledTimes(1);
      expect(fetchCalls).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    });

    it('does not strand the other subscribers when a success-path hook throws synchronously', async () => {
      serve(200, { value: 1 });
      const throwingHook = vi.fn(() => {
        throw new Error('sync boom');
      });
      const healthy = vi.fn();

      const results = await Promise.allSettled([
        dispatchRequest(req({ hooks: { onRequestResponse: throwingHook } })),
        dispatchRequest(req({ hooks: { onRequestResponse: healthy } })),
      ]);

      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('fulfilled');
      expect(healthy).toHaveBeenCalledTimes(1);

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    });
  });

  /**
   * Delivery used to be a serial `for … await` loop, so one caller's slow hook delayed
   * every caller behind it. Each subscriber's work is its own; they run concurrently.
   */
  it('does not let one caller’s slow hook hold up the others', async () => {
    serve(200, { value: 1 });
    const order: string[] = [];

    const slow = dispatchRequest(
      req({
        hooks: {
          onRequestResponse: async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            order.push('slow');
          },
        },
      }),
    );
    const fast = dispatchRequest(
      req({
        hooks: {
          onRequestResponse: () => {
            order.push('fast');
          },
        },
      }),
    );

    await Promise.all([slow, fast]);
    expect(order).toEqual(['fast', 'slow']);
    expect(fetchCalls).toBe(1);
  });

  /**
   * Every subscriber shares one cache key, so a per-subscriber write meant N redundant
   * writes whose winner depended on hook timing. Only the caller that started the request
   * writes, and what it writes is the server's data — no caller's transforms — so a later
   * cache hit applies its own.
   */
  it('writes the cache once, with the server’s untransformed data', async () => {
    serve(200, { value: 1 });
    const cache = new MemoryCache();
    const setSpy = vi.spyOn(cache, 'set');

    await Promise.all([
      dispatchRequest(req({ cache, transformResponse: (d: any) => ({ ...d, who: 'first' }) })),
      dispatchRequest(req({ cache, transformResponse: (d: any) => ({ ...d, who: 'second' }) })),
      dispatchRequest(req({ cache, transformResponse: (d: any) => ({ ...d, who: 'third' }) })),
    ]);

    expect(fetchCalls).toBe(1);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls[0][1]).toMatchObject({ data: { value: 1 } });
    expect(setSpy.mock.calls[0][1].data).not.toHaveProperty('who');
  });

  it('still gives each subscriber its own transformed copy', async () => {
    serve(200, { value: 1 });
    const [a, b] = await Promise.all([
      dispatchRequest(req({ transformResponse: (d: any) => ({ ...d, who: 'a' }) })),
      dispatchRequest(req({ transformResponse: (d: any) => ({ ...d, who: 'b' }) })),
    ]);
    expect(a.data).toEqual({ value: 1, who: 'a' });
    expect(b.data).toEqual({ value: 1, who: 'b' });
    expect(fetchCalls).toBe(1);
  });

  it('gives each subscriber an error carrying its own config', async () => {
    serve(500);
    const results = await Promise.allSettled([
      dispatchRequest(req({ timeout: 111 })),
      dispatchRequest(req({ timeout: 222 })),
    ]);
    const timeouts = results.map((r) =>
      r.status === 'rejected' ? r.reason.config?.timeout : undefined,
    );
    expect(timeouts).toEqual([111, 222]);
  });
});

/**
 * A cache hit that fails `validateStatus` reproduces identically on every attempt — the
 * request never reaches the network — so the retry loop used to spend its whole backoff
 * schedule re-reading the same entry.
 */
describe('retry does not spin on a cache replay', () => {
  it('fails immediately instead of retrying a rejected cache hit', async () => {
    let fetchCalls = 0;
    global.fetch = vi.fn(() => {
      fetchCalls++;
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as any;

    const cache = new MemoryCache();
    const base = {
      url: 'https://api.test.com/cached',
      method: 'get',
      cache,
    };

    // Populate the cache with a 202 that the *writing* caller accepts.
    await dispatchRequest({ ...base, validateStatus: (s: number) => s === 202 } as any);
    expect(fetchCalls).toBe(1);

    // A second caller demands exactly 200. The replayed 202 fails for it, and no amount
    // of retrying can change that — the request never reaches the network again.
    // `retryCondition` says "always retry" precisely to show the cache marker overrides
    // it: with the default condition a 202 would not be retried anyway, so the spin this
    // guards against only ever bit callers with a permissive custom condition.
    const onRetry = vi.fn();
    const started = Date.now();
    await expect(
      retryRequest(dispatchRequest, {
        ...base,
        validateStatus: (s: number) => s === 200,
        retryCondition: () => true,
        retry: 3,
        retryDelay: 200,
        onRetry,
      } as any),
    ).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE' });

    expect(onRetry).not.toHaveBeenCalled();
    expect(fetchCalls).toBe(1);
    expect(Date.now() - started).toBeLessThan(150);
  });

  it('still retries an ordinary live failure', async () => {
    let fetchCalls = 0;
    global.fetch = vi.fn(() => {
      fetchCalls++;
      return Promise.resolve(
        new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }),
      );
    }) as any;

    await expect(
      retryRequest(dispatchRequest, {
        url: 'https://api.test.com/live',
        method: 'get',
        validateStatus: (s: number) => s < 400,
        retry: 2,
        retryDelay: 1,
      } as any),
    ).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE' });
    expect(fetchCalls).toBe(3);
  });
});

describe('Deduplicated request transforms', () => {
  it('applies independent response transforms for concurrently deduplicated requests', async () => {
    const client = new Corriere();

    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve('{"name": "Alice"}'),
    });

    const p1 = client.request({
      url: '/shared',
      dedupe: true,
      transformResponse: [(data: any) => ({ ...data, tag: 'REQ_A' })],
    });

    const p2 = client.request({
      url: '/shared',
      dedupe: true,
      transformResponse: [(data: any) => ({ ...data, tag: 'REQ_B' })],
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.data).toEqual({ name: 'Alice', tag: 'REQ_A' });
    expect(r2.data).toEqual({ name: 'Alice', tag: 'REQ_B' });
  });
});

describe('Deduplication independent abort signals', () => {
  it('allows one deduplicated caller to abort without affecting another caller', async () => {
    const client = new Corriere();

    let resolveFetch: (res: any) => void = () => {};
    global.fetch = vi.fn().mockImplementation(() => {
      return new Promise((resolve) => {
        resolveFetch = () =>
          resolve({
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'application/json' }),
            text: () => Promise.resolve('{"data": "success"}'),
          });
      });
    });

    const ctrlA = new AbortController();
    const ctrlB = new AbortController();

    const pA = client.request({
      url: '/shared-resource',
      dedupe: true,
      signal: ctrlA.signal,
    });

    const pB = client.request({
      url: '/shared-resource',
      dedupe: true,
      signal: ctrlB.signal,
    });

    // Abort only request A
    ctrlA.abort('aborted A');

    // Request A should be rejected with cancellation error
    await expect(pA).rejects.toMatchObject({
      isCorriereError: true,
      code: 'ERR_CANCELED',
      message: 'aborted A',
    });

    // Resolve the fetch promise
    resolveFetch({});

    // Request B should succeed normally since it was not aborted
    const resB = await pB;
    expect(resB.data).toEqual({ data: 'success' });
  });
});

/**
 * When every subscriber of a deduped request aborted, the record stayed in the in-flight map
 * until the aborted fetch actually rejected. A caller arriving in that window — React
 * StrictMode's mount → unmount → mount is exactly this — joined the doomed record and was
 * handed an `ERR_CANCELED` it never asked for.
 */
describe('dedupe after every subscriber aborted', () => {
  it('starts a fresh request for a new caller instead of joining the aborted one', async () => {
    let fetchCalls = 0;
    global.fetch = vi.fn((_url: any, init: RequestInit) => {
      fetchCalls++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve(
              new Response(JSON.stringify({ ok: true }), {
                headers: { 'content-type': 'application/json' },
              }),
            ),
          10,
        );
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(init.signal!.reason);
        });
      });
    }) as any;

    const client = new Corriere();
    const controller = new AbortController();
    const first = client.get('https://api.test.com/strict', {
      dedupe: true,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    const second = client.get('https://api.test.com/strict', { dedupe: true });

    await expect(first).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    await expect(second).resolves.toMatchObject({ data: { ok: true } });
    expect(fetchCalls).toBe(2);
  });
});

/**
 * A `ReadableStream` cannot be cloned, so deduping a stream request handed every caller the
 * same stream object — only the first could ever read it.
 */
describe('dedupe does not apply to stream responses', () => {
  it('gives each concurrent stream caller its own body', async () => {
    let fetchCalls = 0;
    global.fetch = vi.fn(() => {
      fetchCalls++;
      return Promise.resolve(new Response('a\nb\n', { headers: { 'content-type': 'text/plain' } }));
    }) as any;

    const client = new Corriere();
    const [r1, r2] = await Promise.all([
      client.get('https://api.test.com/s', { dedupe: true, responseType: 'stream' }),
      client.get('https://api.test.com/s', { dedupe: true, responseType: 'stream' }),
    ]);

    expect(r1.data).not.toBe(r2.data);
    expect(fetchCalls).toBe(2);
    expect(await new Response(r1.data).text()).toBe('a\nb\n');
    expect(await new Response(r2.data).text()).toBe('a\nb\n');
  });
});
