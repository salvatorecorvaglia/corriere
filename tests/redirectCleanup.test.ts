import { describe, expect, it, vi } from 'vitest';
import dispatchRequest from '../src/core/request';

describe('discarded redirect bodies', () => {
  it.each([
    ['limit', '/again', 'ERR_FR_TOO_MANY_REDIRECTS'],
    ['invalid location', 'http://[', 'ERR_INVALID_URL'],
    ['protocol', 'file:///private', 'ERR_BAD_OPTION'],
    ['opaque', '/next', 'ERR_NOT_SUPPORT'],
  ])('cancels bodies exactly once on %s rejection', async (kind, location, code) => {
    const cancels: ReturnType<typeof vi.fn>[] = [];
    const fetch = vi.fn(async () => {
      const cancel = vi.fn();
      cancels.push(cancel);
      const response = new Response(new ReadableStream({ cancel }), {
        status: 302,
        headers: { location },
      });
      if (kind === 'opaque') Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
      return response;
    });
    await expect(
      dispatchRequest({ url: 'https://example.test', fetch, maxRedirects: 1 }),
    ).rejects.toMatchObject({ code });
    expect(fetch).toHaveBeenCalledTimes(kind === 'limit' ? 2 : 1);
    for (const cancel of cancels) expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(['throw', 'reject'])(
    'retains the original redirect error if cancellation fails (%s)',
    async (mode) => {
      const cancel = vi.fn(() => {
        if (mode === 'throw') throw new Error('cleanup failed');
        return Promise.reject(new Error('cleanup failed'));
      });
      await expect(
        dispatchRequest({
          url: 'https://example.test',
          maxRedirects: 1,
          fetch: async () =>
            new Response(new ReadableStream({ cancel }), {
              status: 302,
              headers: { location: 'file:///private' },
            }),
        }),
      ).rejects.toMatchObject({
        code: 'ERR_BAD_OPTION',
        message: expect.stringContaining('protocol'),
      });
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it('follows valid redirects despite cleanup failures and transfers the final body', async () => {
    const discarded = vi.fn(() => Promise.reject(new Error('cleanup failed')));
    const terminal = vi.fn();
    let calls = 0;
    const response = await dispatchRequest({
      url: 'https://example.test',
      maxRedirects: 1,
      responseType: 'stream',
      fetch: async () =>
        ++calls === 1
          ? new Response(new ReadableStream({ cancel: discarded }), {
              status: 302,
              headers: { location: '/next' },
            })
          : new Response(new ReadableStream({ cancel: terminal })),
    });
    expect(calls).toBe(2);
    expect(discarded).toHaveBeenCalledTimes(1);
    expect(terminal).not.toHaveBeenCalled();
    await (response.data as ReadableStream).cancel();
    expect(terminal).toHaveBeenCalledTimes(1);
  });

  it.each(['no location', 'max zero'])(
    'leaves a returned redirect body readable (%s)',
    async (kind) => {
      const cancel = vi.fn();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('redirect body'));
          controller.close();
        },
        cancel,
      });
      const response = await dispatchRequest({
        url: 'https://example.test',
        maxRedirects: kind === 'max zero' ? 0 : 1,
        fetch: async () =>
          new Response(body, {
            status: 302,
            headers: kind === 'max zero' ? { location: '/next' } : {},
          }),
      });
      expect(response.data).toBe('redirect body');
      expect(cancel).not.toHaveBeenCalled();
    },
  );
});
