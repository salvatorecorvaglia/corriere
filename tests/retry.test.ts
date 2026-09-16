import { describe, expect, it, vi } from 'vitest';
import CorriereError from '../src/core/corriereError';
import retryRequest, { calculateDelay, defaultRetryCondition } from '../src/core/retry';
import Corriere from '../src/corriere';

describe('retry.ts', () => {
  describe('defaultRetryCondition', () => {
    it('does not retry on ERR_CANCELED', () => {
      const error = new CorriereError('cancelled', CorriereError.ERR_CANCELED, null, null, null);
      expect(defaultRetryCondition(error)).toBe(false);
    });

    it('retries on ERR_NETWORK', () => {
      const error = new CorriereError('network', CorriereError.ERR_NETWORK, null, null, null);
      expect(defaultRetryCondition(error)).toBe(true);
    });

    // Inverted in v5. A timeout is a request that got no answer — the same class of
    // failure as ERR_NETWORK, and the most common reason to configure a retry at all.
    // Previously `{ timeout, retry }` together looked configured but never retried.
    it('retries on ETIMEDOUT', () => {
      const error = new CorriereError('timeout', CorriereError.ETIMEDOUT, null, null, null);
      expect(defaultRetryCondition(error)).toBe(true);
    });

    it('retries on ECONNABORTED', () => {
      const error = new CorriereError('aborted', CorriereError.ECONNABORTED, null, null, null);
      expect(defaultRetryCondition(error)).toBe(true);
    });

    it('still does not retry a cancellation', () => {
      const error = new CorriereError('canceled', CorriereError.ERR_CANCELED, null, null, null);
      expect(defaultRetryCondition(error)).toBe(false);
    });

    it('does not retry a timeout when retry is 0', async () => {
      let calls = 0;
      const dispatch = () => {
        calls++;
        return Promise.reject(
          new CorriereError('timeout', CorriereError.ETIMEDOUT, null, null, null),
        );
      };
      await expect(retryRequest(dispatch, { retry: 0 })).rejects.toMatchObject({
        code: 'ETIMEDOUT',
      });
      expect(calls).toBe(1);
    });

    it('retries a timeout up to the configured limit', async () => {
      let calls = 0;
      const dispatch = () => {
        calls++;
        return Promise.reject(
          new CorriereError('timeout', CorriereError.ETIMEDOUT, null, null, null),
        );
      };
      await expect(retryRequest(dispatch, { retry: 2, retryDelay: 1 })).rejects.toMatchObject({
        code: 'ETIMEDOUT',
      });
      expect(calls).toBe(3);
    });

    it('retries on 5xx server errors', () => {
      const error = new CorriereError(
        'server error',
        CorriereError.ERR_BAD_RESPONSE,
        null,
        null,
        null,
      );
      Object.defineProperty(error, 'response', {
        value: {
          status: 503,
          data: null,
          headers: {},
          config: {},
          request: {},
          duration: 0,
          statusText: '',
        },
      });
      expect(defaultRetryCondition(error)).toBe(true);
    });

    it('does not retry on 4xx client errors', () => {
      const error = new CorriereError(
        'client error',
        CorriereError.ERR_BAD_REQUEST,
        null,
        null,
        null,
      );
      Object.defineProperty(error, 'response', {
        value: {
          status: 404,
          data: null,
          headers: {},
          config: {},
          request: {},
          duration: 0,
          statusText: '',
        },
      });
      expect(defaultRetryCondition(error)).toBe(false);
    });
  });

  describe('calculateDelay', () => {
    it('returns a number', () => {
      const delay = calculateDelay(0, 1000);
      expect(typeof delay).toBe('number');
    });

    it('increases with attempt number', () => {
      const delays = Array.from({ length: 100 }, () => calculateDelay(2, 1000));
      const avg = delays.reduce((a, b) => a + b, 0) / delays.length;
      expect(avg).toBeGreaterThan(2000);
    });
  });

  describe('retryRequest', () => {
    it('calls dispatch once when retry is 0', async () => {
      const dispatch = vi.fn(() => Promise.resolve({ status: 200 }));
      const config = { retry: 0 };

      await retryRequest(dispatch, config);
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('does not retry when retry is not set', async () => {
      const dispatch = vi.fn(() => Promise.resolve({ status: 200 }));
      const config = {};

      await retryRequest(dispatch, config);
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('retries on failure and succeeds', async () => {
      let attempt = 0;
      const dispatch = vi.fn(() => {
        attempt++;
        if (attempt < 3) {
          return Promise.reject(
            new CorriereError('network', CorriereError.ERR_NETWORK, null, null, null),
          );
        }
        return Promise.resolve({ status: 200 });
      });

      const config = { retry: 3, retryDelay: 1 };

      const result = await retryRequest(dispatch, config);
      expect(result.status).toBe(200);
      expect(dispatch).toHaveBeenCalledTimes(3);
    });

    it('throws after exhausting retries', async () => {
      const dispatch = vi.fn(() =>
        Promise.reject(new CorriereError('network', CorriereError.ERR_NETWORK, null, null, null)),
      );

      const config = { retry: 2, retryDelay: 1 };

      await expect(retryRequest(dispatch, config)).rejects.toMatchObject({
        code: 'ERR_NETWORK',
      });
      expect(dispatch).toHaveBeenCalledTimes(3);
    });

    it('does not retry when retryCondition returns false', async () => {
      const dispatch = vi.fn(() =>
        Promise.reject(
          new CorriereError('bad request', CorriereError.ERR_BAD_REQUEST, null, null, null),
        ),
      );

      const config = {
        retry: 3,
        retryDelay: 1,
        retryCondition: () => false,
      };

      await expect(retryRequest(dispatch, config)).rejects.toMatchObject({
        code: 'ERR_BAD_REQUEST',
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('calls onRetry callback before each retry', async () => {
      let attempt = 0;
      const dispatch = vi.fn(() => {
        attempt++;
        if (attempt < 3) {
          return Promise.reject(
            new CorriereError('net', CorriereError.ERR_NETWORK, null, null, null),
          );
        }
        return Promise.resolve({ status: 200 });
      });

      const onRetry = vi.fn();
      const config = { retry: 3, retryDelay: 1, onRetry };

      await retryRequest(dispatch, config);
      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledWith(1, expect.any(CorriereError), config);
      expect(onRetry).toHaveBeenCalledWith(2, expect.any(CorriereError), config);
    });

    it('uses custom retryCondition', async () => {
      let attempt = 0;
      const dispatch = vi.fn(() => {
        attempt++;
        const error = new CorriereError('error', CorriereError.ERR_BAD_REQUEST, null, null, null);
        Object.defineProperty(error, 'response', {
          value: {
            status: 429,
            data: null,
            headers: {},
            config: {},
            request: {},
            duration: 0,
            statusText: '',
          },
        });
        if (attempt < 2) return Promise.reject(error);
        return Promise.resolve({ status: 200 });
      });

      const config = {
        retry: 3,
        retryDelay: 1,
        retryCondition: (error: any) => error.response?.status === 429,
      };

      const result = await retryRequest(dispatch, config);
      expect(result.status).toBe(200);
      expect(dispatch).toHaveBeenCalledTimes(2);
    });

    it('aborts retry wait when signal is aborted', async () => {
      const controller = new AbortController();
      let attempt = 0;
      const dispatch = vi.fn(() => {
        attempt++;
        if (attempt < 2) {
          return Promise.reject(
            new CorriereError('network', CorriereError.ERR_NETWORK, null, null, null),
          );
        }
        return Promise.resolve({ status: 200 });
      });

      const config = {
        retry: 3,
        retryDelay: 10000,
        signal: controller.signal,
      };

      const retryPromise = retryRequest(dispatch, config);

      setTimeout(() => controller.abort(new Error('Test abort')), 10);

      await expect(retryPromise).rejects.toThrow('Test abort');
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('retryOn429', () => {
    function make429(headers: Record<string, string> = {}) {
      const err = new CorriereError(
        'rate limited',
        CorriereError.ERR_BAD_REQUEST,
        { retryOn429: true } as any,
        null,
        null,
      );
      Object.defineProperty(err, 'response', {
        value: {
          status: 429,
          headers,
          data: null,
          config: {},
          request: {},
          duration: 0,
          statusText: 'Too Many Requests',
        },
      });
      return err;
    }

    it('retries a 429 when retryOn429 is true', async () => {
      const dispatch = vi
        .fn()
        .mockRejectedValueOnce(make429({ 'retry-after': '0' }))
        .mockResolvedValueOnce({ status: 200, data: 'ok' });

      const res = await retryRequest(dispatch, { retryOn429: true, retryDelay: 1 });
      expect(res).toEqual({ status: 200, data: 'ok' });
      expect(dispatch).toHaveBeenCalledTimes(2);
    });

    it('does not retry a 429 when retryOn429 is false', async () => {
      const err = new CorriereError(
        'rate limited',
        CorriereError.ERR_BAD_REQUEST,
        { retryOn429: false } as any,
        null,
        null,
      );
      Object.defineProperty(err, 'response', {
        value: {
          status: 429,
          headers: {},
          data: null,
          config: {},
          request: {},
          duration: 0,
          statusText: '',
        },
      });
      const dispatch = vi.fn().mockRejectedValue(err);
      await expect(retryRequest(dispatch, { retry: 2, retryDelay: 1 })).rejects.toMatchObject({
        code: CorriereError.ERR_BAD_REQUEST,
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('honors numeric Retry-After (seconds)', async () => {
      const dispatch = vi
        .fn()
        .mockRejectedValueOnce(make429({ 'retry-after': '1' }))
        .mockResolvedValueOnce({ status: 200 });

      const start = Date.now();
      await retryRequest(dispatch, { retryOn429: true, retryDelay: 1 });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(900);
    }, 5000);

    it('clamps a negative numeric Retry-After to an immediate retry instead of a negative delay', async () => {
      const dispatch = vi
        .fn()
        .mockRejectedValueOnce(make429({ 'retry-after': '-5' }))
        .mockResolvedValueOnce({ status: 200 });

      const start = Date.now();
      const res = await retryRequest(dispatch, { retryOn429: true, retryDelay: 1 });
      const elapsed = Date.now() - start;

      expect(res).toEqual({ status: 200 });
      expect(dispatch).toHaveBeenCalledTimes(2);
      expect(elapsed).toBeLessThan(500);
    }, 5000);

    it('honors HTTP-date Retry-After', async () => {
      // HTTP-date is second-precision; pad with 2s so the rounded value stays in the future.
      const future = new Date(Date.now() + 2000).toUTCString();
      const dispatch = vi
        .fn()
        .mockRejectedValueOnce(make429({ 'retry-after': future }))
        .mockResolvedValueOnce({ status: 200 });

      const start = Date.now();
      await retryRequest(dispatch, { retryOn429: true, retryDelay: 1 });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(500);
    }, 5000);
  });

  describe('unretriable bodies', () => {
    it('refuses to retry when data is a ReadableStream and surfaces ERR_BAD_OPTION', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('payload'));
          controller.close();
        },
      });

      const networkError = new CorriereError(
        'network down',
        CorriereError.ERR_NETWORK,
        null,
        null,
        null,
      );
      const dispatch = vi.fn().mockRejectedValue(networkError);

      await expect(
        retryRequest(dispatch, {
          url: '/x',
          method: 'POST',
          data: stream,
          retry: 3,
          retryDelay: 1,
        }),
      ).rejects.toMatchObject({
        isCorriereError: true,
        code: CorriereError.ERR_BAD_OPTION,
        message: expect.stringContaining('ReadableStream'),
      });

      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('still retries when body is a plain object', async () => {
      const networkError = new CorriereError(
        'network down',
        CorriereError.ERR_NETWORK,
        null,
        null,
        null,
      );
      const dispatch = vi
        .fn()
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce({ status: 200, data: 'ok' });

      const result = await retryRequest(dispatch, {
        url: '/x',
        method: 'POST',
        data: { hello: 'world' },
        retry: 2,
        retryDelay: 1,
      });

      expect(result).toEqual({ status: 200, data: 'ok' });
      expect(dispatch).toHaveBeenCalledTimes(2);
    });
  });
});

describe('retryRequest with retry: 0 and retryOn429: true', () => {
  it('does not retry non-429 errors', async () => {
    const dispatch = vi
      .fn()
      .mockRejectedValue(
        new CorriereError('network error', CorriereError.ERR_NETWORK, null, null, null),
      );

    const config = { retry: 0, retryOn429: true };

    await expect(retryRequest(dispatch, config)).rejects.toThrow('network error');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('retries 429 errors up to 3 times', async () => {
    const err = new CorriereError(
      'rate limited',
      CorriereError.ERR_BAD_REQUEST,
      { retryOn429: true } as any,
      null,
      null,
    );
    Object.defineProperty(err, 'response', {
      value: {
        status: 429,
        headers: {},
        data: null,
        config: {},
        request: {},
        duration: 0,
        statusText: 'Too Many Requests',
      },
    });

    const dispatch = vi.fn().mockRejectedValue(err);
    const config = { retry: 0, retryOn429: true, retryDelay: 1 };

    await expect(retryRequest(dispatch, config)).rejects.toThrow('rate limited');
    // Should run once initially + 3 retries = 4 attempts total
    expect(dispatch).toHaveBeenCalledTimes(4);
  });
});

describe('Retry sleep cancellation wrapper', () => {
  it('wraps sleep abort inside an CorriereError with ERR_CANCELED code', async () => {
    const client = new Corriere();
    const controller = new AbortController();

    let calls = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      calls++;
      if (calls === 1) {
        // Fail with network error to trigger retry sleep
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return Promise.resolve({
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: () => Promise.resolve('{}'),
      });
    });

    // Start request with retry and signal
    const promise = client.request({
      url: '/retry-abort-test',
      retry: 2,
      retryDelay: 2000,
      signal: controller.signal,
    });

    // Wait a tiny bit then abort signal during retry sleep
    setTimeout(() => {
      controller.abort('User abort reason');
    }, 500);

    await expect(promise).rejects.toMatchObject({
      isCorriereError: true,
      code: 'ERR_CANCELED',
      message: 'User abort reason',
    });
  });
});

describe('onRetry is an observer, not a failure path', () => {
  it('a throwing onRetry does not replace the error or stop retrying', async () => {
    const err = new CorriereError('network error', CorriereError.ERR_NETWORK, null, null, null);
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ status: 200, data: 'ok' });

    const res = await retryRequest(dispatch, {
      retry: 3,
      retryDelay: 1,
      onRetry: () => {
        throw new Error('logger exploded');
      },
    });

    expect(res).toEqual({ status: 200, data: 'ok' });
    expect(dispatch).toHaveBeenCalledTimes(3);
  });
});
