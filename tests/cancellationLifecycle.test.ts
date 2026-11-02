import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import corriere from '../src/index';
import type { CorriereRequestConfig } from '../src/types';

describe('cancellation before dispatch', () => {
  it.each(['cache', 'dedupe', 'plain'])(
    'does no work for a pre-aborted %s request',
    async (mode) => {
      const fetch = vi.fn(async () => new Response('{}'));
      const get = vi.fn();
      const hooks = { onBeforeRequest: vi.fn() };
      const controller = new AbortController();
      controller.abort('stop');
      const cache = { get, set: vi.fn(), delete: vi.fn(), clear: vi.fn() };
      const client = corriere.create({ fetch });
      await expect(
        client.get('https://example.test', {
          signal: controller.signal,
          hooks,
          cache: mode === 'cache' ? cache : false,
          dedupe: mode === 'dedupe',
        }),
      ).rejects.toMatchObject({ code: 'ERR_CANCELED', message: 'stop' });
      expect(fetch).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(hooks.onBeforeRequest).not.toHaveBeenCalled();
    },
  );

  it('rejects a pre-aborted cache hit', async () => {
    const fetch = vi.fn(async () => new Response('{}'));
    const client = corriere.create({ fetch, cache: true });
    await client.get('https://example.test');
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.get('https://example.test', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['hook', 'cache', 'transform'])(
    'rechecks cancellation after awaiting a %s',
    async (stage) => {
      const controller = new AbortController();
      const fetch = vi.fn(async () => new Response('{}'));
      const cancel = async () => {
        controller.abort('during setup');
      };
      const client = corriere.create({ fetch });
      const config: CorriereRequestConfig = { signal: controller.signal, dedupe: true };
      if (stage === 'hook') config.hooks = { onBeforeRequest: cancel };
      if (stage === 'transform') config.transformRequest = cancel;
      if (stage === 'cache')
        config.cache = {
          get: cancel,
          set: vi.fn(),
          delete: vi.fn(),
          clear: vi.fn(),
        };
      await expect(client.get('https://example.test', config)).rejects.toMatchObject({
        code: 'ERR_CANCELED',
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe('stream ownership on processing failure', () => {
  it.each(['status', 'transform', 'schema', 'hook'])(
    'cancels the original body after %s rejection',
    async (stage) => {
      const cancel = vi.fn();
      const body = new ReadableStream({ cancel });
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const failure = new Error('processing failed');
      const config: CorriereRequestConfig = {
        responseType: 'stream',
        timeout: 60_000,
        signal: controller.signal,
        fetch: async () => new Response(body, { status: stage === 'status' ? 500 : 200 }),
      };
      if (stage === 'transform')
        config.transformResponse = () => {
          throw failure;
        };
      if (stage === 'schema')
        config.schema = {
          parse: () => {
            throw failure;
          },
        };
      if (stage === 'hook')
        config.hooks = {
          onRequestResponse: () => {
            throw failure;
          },
        };
      await expect(corriere.get('https://example.test', config)).rejects.toThrow();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls.some(([type]) => type === 'abort')).toBe(true);
    },
  );

  it('preserves the failure if cancellation itself fails', async () => {
    const client = corriere.create({
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              throw new Error('cleanup failed');
            },
          }),
          { status: 500 },
        ),
    });
    await expect(
      client.get('https://example.test', { responseType: 'stream' }),
    ).rejects.toMatchObject({
      code: 'ERR_BAD_RESPONSE',
      message: 'Request failed with status code 500',
    });
  });

  it('destroys Node response streams on rejection', async () => {
    const body = new Readable({ read() {} });
    const fetch = vi.fn(
      async () =>
        ({
          status: 500,
          statusText: '',
          headers: new Headers(),
          body,
        }) as unknown as Response,
    );
    await expect(
      corriere.get('https://example.test', { fetch, responseType: 'stream' }),
    ).rejects.toThrow();
    expect(body.destroyed).toBe(true);
  });

  it('releases timeout wiring for a bodyless stream response', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const response = await corriere.get('https://example.test', {
      signal: controller.signal,
      timeout: 60_000,
      responseType: 'stream',
      fetch: async () => new Response(null, { status: 204 }),
    });
    expect(response.data).toBeNull();
    expect(remove.mock.calls.some(([type]) => type === 'abort')).toBe(true);
  });
});
