import { describe, expect, it } from 'vitest';
import CorriereError from '../src/core/corriereError';
import { createRateLimiter, rateLimitedRequest } from '../src/helpers/rateLimiter';

describe('createRateLimiter', () => {
  it('starts with zero active and pending', () => {
    const limiter = createRateLimiter(3);
    expect(limiter.active).toBe(0);
    expect(limiter.pending).toBe(0);
  });

  it('acquires slots up to maxConcurrent', async () => {
    const limiter = createRateLimiter(2);

    await limiter.acquire();
    expect(limiter.active).toBe(1);

    await limiter.acquire();
    expect(limiter.active).toBe(2);
    expect(limiter.pending).toBe(0);
  });

  it('queues when maxConcurrent is reached', async () => {
    const limiter = createRateLimiter(1);
    await limiter.acquire();
    expect(limiter.active).toBe(1);

    let resolved = false;
    const pending = limiter.acquire().then(() => {
      resolved = true;
    });
    expect(limiter.pending).toBe(1);
    expect(resolved).toBe(false);

    limiter.release();
    await pending;
    expect(resolved).toBe(true);
    expect(limiter.active).toBe(1);
    expect(limiter.pending).toBe(0);
  });

  it('releases correctly', async () => {
    const limiter = createRateLimiter(2);
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.active).toBe(2);

    limiter.release();
    expect(limiter.active).toBe(1);

    limiter.release();
    expect(limiter.active).toBe(0);
  });

  it('works with Infinity (no limit)', async () => {
    const limiter = createRateLimiter(Number.POSITIVE_INFINITY);
    for (let i = 0; i < 100; i++) {
      await limiter.acquire();
    }
    expect(limiter.active).toBe(100);
    expect(limiter.pending).toBe(0);
  });

  it('defaults to Infinity', async () => {
    const limiter = createRateLimiter();
    for (let i = 0; i < 50; i++) {
      await limiter.acquire();
    }
    expect(limiter.active).toBe(50);
    expect(limiter.pending).toBe(0);
  });

  it('promotes queued waiters in FIFO order', async () => {
    const limiter = createRateLimiter(1);
    await limiter.acquire();

    const order: number[] = [];
    const p1 = limiter.acquire().then(() => order.push(1));
    const p2 = limiter.acquire().then(() => order.push(2));
    const p3 = limiter.acquire().then(() => order.push(3));
    expect(limiter.pending).toBe(3);

    limiter.release();
    await p1;
    limiter.release();
    await p2;
    limiter.release();
    await p3;

    expect(order).toEqual([1, 2, 3]);
    expect(limiter.pending).toBe(0);
    expect(limiter.active).toBe(1);
  });

  it('rejects when maxQueueSize is exceeded', async () => {
    const limiter = createRateLimiter(1, 2);
    await limiter.acquire();
    const a = limiter.acquire();
    const b = limiter.acquire();
    await expect(limiter.acquire()).rejects.toThrow('maxQueueSize');
    expect(limiter.pending).toBe(2);
    limiter.release();
    await a;
    limiter.release();
    await b;
  });

  it('rejects queue overflow with a classifiable CorriereError', async () => {
    const limiter = createRateLimiter(1, 1);
    await limiter.acquire();
    const queued = limiter.acquire();

    try {
      await limiter.acquire();
      throw new Error('expected acquire() to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(CorriereError);
      expect((err as CorriereError).isCorriereError).toBe(true);
      expect((err as CorriereError).code).toBe('ERR_RATE_LIMIT_QUEUE_FULL');
    }

    limiter.release();
    await queued;
  });

  it('handles long churn without leaking queue entries', async () => {
    const limiter = createRateLimiter(4);
    for (let i = 0; i < 5000; i++) {
      await limiter.acquire();
      limiter.release();
    }
    expect(limiter.active).toBe(0);
    expect(limiter.pending).toBe(0);
  });

  describe('destroy()', () => {
    it('starts as not destroyed', () => {
      const limiter = createRateLimiter(2);
      expect(limiter.destroyed).toBe(false);
    });

    it('marks the limiter as destroyed', () => {
      const limiter = createRateLimiter(2);
      limiter.destroy();
      expect(limiter.destroyed).toBe(true);
    });

    it('rejects all queued pending promises', async () => {
      const limiter = createRateLimiter(1);
      await limiter.acquire();

      const results = [
        limiter.acquire().catch((e) => e.message),
        limiter.acquire().catch((e) => e.message),
        limiter.acquire().catch((e) => e.message),
      ];

      expect(limiter.pending).toBe(3);

      limiter.destroy();

      const messages = await Promise.all(results);
      expect(limiter.pending).toBe(0);
      for (const msg of messages) {
        expect(msg).toContain('destroyed');
      }
    });

    it('rejects new acquire() calls after destroy', async () => {
      const limiter = createRateLimiter(2);
      limiter.destroy();

      await expect(limiter.acquire()).rejects.toThrow('destroyed');
    });

    it('is idempotent — calling destroy() twice does not throw', () => {
      const limiter = createRateLimiter(2);
      expect(() => {
        limiter.destroy();
        limiter.destroy();
      }).not.toThrow();
    });
  });

  describe('rateLimitedRequest()', () => {
    it('acquires, dispatches and releases automatically', async () => {
      const limiter = createRateLimiter(2);
      const dispatch = (async (config: any) => ({ status: 200, config })) as any;

      const result = await rateLimitedRequest(dispatch, limiter, { url: '/test' });
      expect(result.status).toBe(200);
      expect(limiter.active).toBe(0);
    });

    it('releases even when dispatch throws', async () => {
      const limiter = createRateLimiter(2);
      const dispatch = (async () => {
        throw new Error('network error');
      }) as any;

      await expect(rateLimitedRequest(dispatch, limiter, {})).rejects.toThrow('network error');
      expect(limiter.active).toBe(0);
    });
  });
});

describe('rateLimiter queue ejection on signal abort', () => {
  it('aborts queued acquires immediately and removes them from the queue', async () => {
    const limiter = createRateLimiter(1, 5);

    // Occupy the only concurrent slot
    await limiter.acquire();
    expect(limiter.active).toBe(1);
    expect(limiter.pending).toBe(0);

    // Queue up a second request with an AbortSignal
    const controller = new AbortController();
    const p1 = limiter.acquire(controller.signal);

    expect(limiter.pending).toBe(1);

    // Queue up a third request without abort signal to verify it stays queued
    const p2 = limiter.acquire();
    expect(limiter.pending).toBe(2);

    // Abort the second request
    controller.abort(new Error('Acquire aborted'));

    await expect(p1).rejects.toThrow('Acquire aborted');

    // The second request should be removed, leaving only the third request in queue
    expect(limiter.pending).toBe(1);

    // Release first slot, which should resolve p2
    limiter.release();
    await expect(p2).resolves.toBeUndefined();
    expect(limiter.active).toBe(1);
    expect(limiter.pending).toBe(0);

    limiter.release();
    expect(limiter.active).toBe(0);
  });
});

describe('rate limiter cancellation is a recognisable CorriereError', () => {
  it('rejects a queued acquire with ERR_CANCELED on abort', async () => {
    const limiter = createRateLimiter(1);
    await limiter.acquire(); // occupy the only slot

    const controller = new AbortController();
    const queued = limiter.acquire(controller.signal);
    controller.abort(new Error('user cancelled'));

    const err: any = await queued.catch((e) => e);
    expect(err).toBeInstanceOf(CorriereError);
    expect(err.code).toBe('ERR_CANCELED');
    expect(err.message).toBe('user cancelled');
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('rejects with ERR_CANCELED when the signal is already aborted', async () => {
    const limiter = createRateLimiter(1);
    const controller = new AbortController();
    controller.abort();
    const err: any = await limiter.acquire(controller.signal).catch((e) => e);
    expect(err.code).toBe('ERR_CANCELED');
  });

  it('rejects pending acquires with ERR_CANCELED when destroyed', async () => {
    const limiter = createRateLimiter(1);
    await limiter.acquire();
    const queued = limiter.acquire();
    limiter.destroy();
    const err: any = await queued.catch((e) => e);
    expect(err.code).toBe('ERR_CANCELED');
    expect(err.isCorriereError).toBe(true);
  });

  it('makes a rate-limited abort visible to a retryCondition', async () => {
    const limiter = createRateLimiter(1);
    await limiter.acquire();
    const controller = new AbortController();
    controller.abort(new Error('stop'));

    const err: any = await rateLimitedRequest(() => Promise.resolve({} as any), limiter, {
      signal: controller.signal,
    }).catch((e) => e);

    // defaultRetryCondition keys off error.code; a bare Error was invisible to it.
    expect(err.code).toBe('ERR_CANCELED');
  });
});
