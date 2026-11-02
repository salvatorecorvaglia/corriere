import { describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from '../src/helpers/rateLimiter';

describe('rate limiter queue behavior', () => {
  it.each([0, 1, 2])(
    'removes queued position %s and immediately frees queue capacity',
    async (position) => {
      const limiter = createRateLimiter(1, 3);
      await limiter.acquire();
      const controllers = Array.from({ length: 3 }, () => new AbortController());
      const order: number[] = [];
      const requests = controllers.map((controller, index) =>
        limiter.acquire(controller.signal).then(
          () => {
            order.push(index);
            return null;
          },
          (error) => error,
        ),
      );
      controllers[position].abort('removed');
      expect(limiter.pending).toBe(2);
      const replacement = limiter.acquire().then(() => order.push(3));
      expect(limiter.pending).toBe(3);
      await expect(limiter.acquire()).rejects.toMatchObject({ code: 'ERR_RATE_LIMIT_QUEUE_FULL' });
      for (let i = 0; i < 3; i++) limiter.release();
      const results = await Promise.all(requests);
      await replacement;
      expect(results[position]).toMatchObject({ code: 'ERR_CANCELED', message: 'removed' });
      expect(order).toEqual([0, 1, 2].filter((index) => index !== position).concat(3));
      expect(limiter.pending).toBe(0);
      expect(limiter.active).toBe(1);
      limiter.release();
      expect(limiter.active).toBe(0);
    },
  );

  it('can enqueue again after its only waiter is canceled', async () => {
    const limiter = createRateLimiter(1, 1);
    await limiter.acquire();
    const controller = new AbortController();
    const canceled = limiter.acquire(controller.signal).catch((error) => error);
    controller.abort();
    expect(limiter.pending).toBe(0);
    const replacement = limiter.acquire();
    limiter.release();
    await replacement;
    expect((await canceled).code).toBe('ERR_CANCELED');
    expect(limiter.pending).toBe(0);
    limiter.release();
    expect(limiter.active).toBe(0);
  });

  it('hands off slots without allowing newly arriving work to jump the queue', async () => {
    const limiter = createRateLimiter(2);
    await Promise.all([limiter.acquire(), limiter.acquire()]);
    const order: number[] = [];
    const first = limiter.acquire().then(() => order.push(1));
    const second = limiter.acquire().then(() => order.push(2));
    limiter.release();
    const third = limiter.acquire().then(() => order.push(3));
    expect(limiter.active).toBe(2);
    expect(limiter.pending).toBe(2);
    limiter.release();
    limiter.release();
    await Promise.all([first, second, third]);
    expect(order).toEqual([1, 2, 3]);
    limiter.release();
    limiter.release();
    limiter.release(); // Redundant releases remain harmless.
    expect(limiter.active).toBe(0);
  });

  it.each(['handoff', 'abort', 'destroy'])(
    'removes abort listeners on %s and settles once',
    async (outcome) => {
      const limiter = createRateLimiter(1);
      await limiter.acquire();
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const settled = vi.fn();
      const request = limiter.acquire(controller.signal).then(
        () => settled('acquired'),
        (error) => settled(error.code),
      );
      if (outcome === 'handoff') limiter.release();
      if (outcome === 'abort') controller.abort();
      if (outcome === 'destroy') limiter.destroy();
      await request;
      controller.abort();
      expect(settled).toHaveBeenCalledExactlyOnceWith(
        outcome === 'handoff' ? 'acquired' : 'ERR_CANCELED',
      );
      expect(remove.mock.calls.filter(([type]) => type === 'abort')).toHaveLength(1);
      expect(limiter.pending).toBe(0);
      expect(limiter.active).toBe(1);
      if (outcome !== 'destroy') {
        limiter.release();
        expect(limiter.active).toBe(0);
      }
    },
  );

  it('drains a large queue in FIFO order after widespread cancellation', async () => {
    const limiter = createRateLimiter(1);
    await limiter.acquire();
    const controllers = Array.from({ length: 5000 }, () => new AbortController());
    const order: number[] = [];
    const requests = controllers.map((controller, index) =>
      limiter.acquire(controller.signal).then(
        () => order.push(index),
        () => {},
      ),
    );
    for (let i = controllers.length - 1; i >= 0; i--) {
      if (i % 3 === 0) controllers[i].abort();
    }
    const survivors = controllers.map((_, index) => index).filter((index) => index % 3 !== 0);
    expect(limiter.pending).toBe(survivors.length);
    for (const _ of survivors) limiter.release();
    await Promise.all(requests);
    expect(order).toEqual(survivors);
    expect(limiter.pending).toBe(0);
    limiter.release();
    expect(limiter.active).toBe(0);
  });

  it('destroys a large queue and leaves no waiters after later aborts or releases', async () => {
    const limiter = createRateLimiter(1);
    await limiter.acquire();
    const controller = new AbortController();
    const signaled = limiter.acquire(controller.signal).catch((error) => error.code);
    const requests = Array.from({ length: 10_000 }, () =>
      limiter.acquire().catch((error) => error.code),
    );
    limiter.destroy();
    limiter.destroy();
    controller.abort();
    limiter.release();
    expect(limiter.pending).toBe(0);
    expect(limiter.destroyed).toBe(true);
    expect(limiter.active).toBe(1);
    expect(await signaled).toBe('ERR_CANCELED');
    expect((await Promise.all(requests)).every((code) => code === 'ERR_CANCELED')).toBe(true);
    await expect(limiter.acquire()).rejects.toMatchObject({ code: 'ERR_CANCELED' });
  });
});
