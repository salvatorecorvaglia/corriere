import { beforeEach, describe, expect, it, vi } from 'vitest';
import Corriere from '../src/corriere';

/**
 * The shorthand methods (`get`, `post`, …) used to funnel the caller's config through
 * `mergeConfig` as its *first* argument. `mergeConfig` strips `url`, `data` and `signal`
 * from that position so instance defaults cannot leak request-scoped values — which meant
 * the caller's own `signal` and `data` were silently discarded.
 *
 * These tests assert the config a caller hands to a shorthand actually reaches the wire.
 */
describe('shorthand methods preserve caller config', () => {
  let client: InstanceType<typeof Corriere>;
  let seen: { signal?: AbortSignal | null; body?: BodyInit | null; url?: string };

  beforeEach(() => {
    seen = {};
    client = new Corriere({ baseURL: 'https://api.test.com' });
    global.fetch = vi.fn((url: any, init: any) => {
      seen.url = String(url);
      seen.signal = init?.signal;
      seen.body = init?.body;
      return Promise.resolve(
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as any;
  });

  describe('signal is forwarded', () => {
    for (const method of ['get', 'delete', 'head', 'options'] as const) {
      it(`${method}(url, { signal }) reaches fetch`, async () => {
        const controller = new AbortController();
        await client[method]('/resource', { signal: controller.signal });
        expect(seen.signal).toBeInstanceOf(AbortSignal);
      });
    }

    for (const method of ['post', 'put', 'patch'] as const) {
      it(`${method}(url, data, { signal }) reaches fetch`, async () => {
        const controller = new AbortController();
        await client[method]('/resource', { a: 1 }, { signal: controller.signal });
        expect(seen.signal).toBeInstanceOf(AbortSignal);
      });
    }

    // Mirrors real fetch semantics: reject immediately if the signal is already aborted,
    // otherwise reject when it aborts. A mock that only registers a listener would hang.
    const useAbortAwareFetch = () => {
      global.fetch = vi.fn(
        (_url: any, init: any) =>
          new Promise((_resolve, reject) => {
            const fail = () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            };
            if (init?.signal?.aborted) return fail();
            init?.signal?.addEventListener('abort', fail, { once: true });
          }),
      ) as any;
    };

    it('an already-aborted signal cancels a get()', async () => {
      useAbortAwareFetch();
      const controller = new AbortController();
      controller.abort(new Error('user cancelled'));
      await expect(client.get('/resource', { signal: controller.signal })).rejects.toMatchObject({
        isCorriereError: true,
        code: 'ERR_CANCELED',
      });
    });

    it('aborting mid-flight rejects a post()', async () => {
      useAbortAwareFetch();
      const controller = new AbortController();
      const promise = client.post('/resource', { a: 1 }, { signal: controller.signal });
      controller.abort(new Error('user cancelled'));
      await expect(promise).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    });
  });

  describe('data is forwarded', () => {
    it('delete(url, { data }) sends a body', async () => {
      await client.delete('/resource', { data: { id: 7 } });
      expect(seen.body).toBe(JSON.stringify({ id: 7 }));
    });

    it('the explicit data argument wins over config.data', async () => {
      await client.post('/resource', { from: 'arg' }, { data: { from: 'config' } });
      expect(seen.body).toBe(JSON.stringify({ from: 'arg' }));
    });

    it('config.data is used when the data argument is omitted', async () => {
      await client.post('/resource', undefined, { data: { from: 'config' } });
      expect(seen.body).toBe(JSON.stringify({ from: 'config' }));
    });
  });

  describe('other config still applies', () => {
    it('params from config are serialized into the URL', async () => {
      await client.get('/resource', { params: { page: 2 } });
      expect(seen.url).toContain('page=2');
    });

    it('headers from config are merged with defaults', async () => {
      await client.get('/resource', { headers: { 'X-Trace': 'abc' } });
      const init = (global.fetch as any).mock.calls[0][1];
      expect(init.headers.get('x-trace')).toBe('abc');
      expect(init.headers.get('accept')).toContain('application/json');
    });

    it('postForm still applies its multipart Content-Type handling', async () => {
      await client.postForm('/upload', { field: 'value' });
      expect(seen.body).toBeInstanceOf(FormData);
    });

    it('postForm forwards the caller signal', async () => {
      const controller = new AbortController();
      await client.postForm('/upload', { field: 'value' }, { signal: controller.signal });
      expect(seen.signal).toBeInstanceOf(AbortSignal);
    });
  });
});

describe('method inherited from instance defaults', () => {
  it('should respect default method set in instance config', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve('{}'),
    });
    global.fetch = mockFetch;

    const client = new Corriere({ method: 'post' });
    await client.request({ url: '/test' });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/test'),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('transformResponse on a non-JSON response', () => {
  it('should apply transformResponse for non-JSON response types', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      text: () => Promise.resolve('hello world'),
    });
    global.fetch = mockFetch;

    const transformer = vi.fn((data: any) => data.toUpperCase());
    const client = new Corriere();

    const response = await client.request({
      url: '/test',
      responseType: 'text',
      transformResponse: [transformer],
    });

    expect(transformer).toHaveBeenCalled();
    expect(response.data).toBe('HELLO WORLD');
  });
});
