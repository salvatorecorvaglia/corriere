import { afterEach, describe, expect, it, vi } from 'vitest';
import retryRequest, { calculateDelay } from '../src/core/retry';
import corriere, { type CorriereRequestConfig } from '../src/index';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('retry option validation', () => {
  it.each([
    ...[NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '2', null].map((value) => ({
      key: 'retry',
      value,
    })),
    ...['retryDelay', 'maxRetryDelay'].flatMap((key) =>
      [NaN, Infinity, -1, 2 ** 31, '100', null].map((value) => ({ key, value })),
    ),
    ...[null, 'get', [1], ['']].map((value) => ({ key: 'retryMethods', value })),
  ])('rejects invalid $key=$value before calling the transport', async ({ key, value }) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}'));
    const client = corriere.create({ fetch });
    await expect(
      client.get('https://example.test', { [key]: value } as CorriereRequestConfig),
    ).rejects.toMatchObject({ code: 'ERR_BAD_OPTION_VALUE' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts zero retries and timer boundary values without scheduling a backoff', async () => {
    const dispatch = vi.fn(async () => 'ok');
    await expect(
      retryRequest(dispatch, { retry: 0, retryDelay: 0, maxRetryDelay: 2 ** 31 - 1 }),
    ).resolves.toBe('ok');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('keeps exponential overflow and zero backoffs finite', () => {
    expect(calculateDelay(1024, 0)).toBe(0);
    expect(calculateDelay(1024, 1000)).toBe(30000);
    expect(Number.isFinite(calculateDelay(1023, 2 ** 31 - 1))).toBe(true);
  });

  it('caps oversized Retry-After values at the largest supported timer delay', async () => {
    vi.useFakeTimers();
    const error = {
      response: {
        status: 503,
        headers: { 'retry-after': '9999999999999999999999999999999999999999' },
      },
    };
    const dispatch = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce('ok');
    const request = retryRequest(dispatch, { retry: 1, maxRetryDelay: 2 ** 31 - 1 });
    const done = expect(request).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 ** 31 - 2);
    await done;
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

describe('retry method and cancellation policies', () => {
  it.each(['post', 'patch'])('does not retry %s on 429 by default', async (method) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}', { status: 429 }));
    const client = corriere.create({ fetch, retryOn429: true, retryDelay: 0 });
    await expect(client.request({ url: 'https://example.test', method })).rejects.toMatchObject({
      response: { status: 429 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('respects an empty retryMethods list even with a custom condition and retryOn429', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}', { status: 429 }));
    await expect(
      corriere.create({ fetch }).get('https://example.test', {
        retryOn429: true,
        retry: 1,
        retryDelay: 0,
        retryMethods: [],
        retryCondition: () => true,
      }),
    ).rejects.toMatchObject({ response: { status: 429 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries an explicitly listed POST on 429', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}'));
    await corriere
      .create({ fetch })
      .post(
        'https://example.test',
        {},
        { retryOn429: true, retryDelay: 0, retryMethods: ['POST'] },
      );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([null, undefined, 'original reason'])(
    'preserves an unknown failure without masking it: %s',
    async (reason) => {
      const dispatch = vi.fn(async () => {
        throw reason;
      });
      await expect(retryRequest(dispatch, { retry: 1, retryDelay: 0 })).rejects.toBe(reason);
      expect(dispatch).toHaveBeenCalledTimes(1);
    },
  );

  it('does not notify or retry a cancellation even if a custom condition accepts it', async () => {
    const controller = new AbortController();
    controller.abort('stop');
    const onRetry = vi.fn();
    await expect(
      corriere.get('https://example.test', {
        signal: controller.signal,
        retry: 1,
        retryDelay: 0,
        retryCondition: () => true,
        onRetry,
      }),
    ).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    expect(onRetry).not.toHaveBeenCalled();
  });
});
