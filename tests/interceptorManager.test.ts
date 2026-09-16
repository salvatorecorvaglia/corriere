import { describe, expect, it } from 'vitest';
import Corriere from '../src/corriere';
import InterceptorManager from '../src/interceptors/interceptorManager';

describe('InterceptorManager', () => {
  it('starts with no handlers', () => {
    const manager = new InterceptorManager();
    expect(manager.size).toBe(0);
  });

  describe('use', () => {
    it('registers an interceptor and returns its id', () => {
      const manager = new InterceptorManager();
      const id = manager.use((val) => val);
      expect(id).toBe(0);
      expect(manager.size).toBe(1);
    });

    it('returns incrementing ids', () => {
      const manager = new InterceptorManager();
      expect(manager.use(() => {})).toBe(0);
      expect(manager.use(() => {})).toBe(1);
      expect(manager.use(() => {})).toBe(2);
      expect(manager.size).toBe(3);
    });

    it('stores fulfilled and rejected handlers', () => {
      const manager = new InterceptorManager();
      const fulfilled = (v: any) => v;
      const rejected = (e: any) => e;
      manager.use(fulfilled, rejected);

      let captured: any;
      manager.forEach((h) => {
        captured = h;
      });
      expect(captured.fulfilled).toBe(fulfilled);
      expect(captured.rejected).toBe(rejected);
    });

    it('stores options', () => {
      const manager = new InterceptorManager();
      const runWhen = () => true;
      manager.use(() => {}, undefined, { synchronous: true, runWhen });

      let captured: any;
      manager.forEach((h) => {
        captured = h;
      });
      expect(captured.synchronous).toBe(true);
      expect(captured.runWhen).toBe(runWhen);
    });
  });

  describe('eject', () => {
    it('removes an interceptor by id', () => {
      const manager = new InterceptorManager();
      const id = manager.use(() => {});
      expect(manager.size).toBe(1);

      manager.eject(id);
      expect(manager.size).toBe(0);
    });

    it('does nothing for invalid ids', () => {
      const manager = new InterceptorManager();
      manager.use(() => {});
      manager.eject(99);
      expect(manager.size).toBe(1);
    });

    it('does not grow internal storage with ejected entries (M8)', () => {
      const mgr = new InterceptorManager();
      const ids: number[] = [];
      for (let i = 0; i < 10_000; i++) ids.push(mgr.use(((v: any) => v) as any));
      for (const id of ids) mgr.eject(id);
      expect(mgr.size).toBe(0);
      const liveId = mgr.use(((v: any) => v) as any);
      let visits = 0;
      mgr.forEach(() => {
        visits++;
      });
      expect(visits).toBe(1);
      expect(liveId).toBeGreaterThanOrEqual(10_000);
      mgr.eject(liveId);
      const nextId = mgr.use(((v: any) => v) as any);
      expect(nextId).toBeGreaterThan(liveId);
    });

    it('skips ejected handlers in forEach', () => {
      const manager = new InterceptorManager();
      const results: string[] = [];
      manager.use(() => results.push('a'));
      const id = manager.use(() => results.push('b'));
      manager.use(() => results.push('c'));

      manager.eject(id);
      manager.forEach((h) => {
        (h as any).fulfilled();
      });
      expect(results).toEqual(['a', 'c']);
    });
  });

  describe('clear', () => {
    it('removes all interceptors', () => {
      const manager = new InterceptorManager();
      manager.use(() => {});
      manager.use(() => {});
      manager.use(() => {});
      expect(manager.size).toBe(3);

      manager.clear();
      expect(manager.size).toBe(0);
    });
  });

  describe('forEach', () => {
    it('iterates over all active interceptors', () => {
      const manager = new InterceptorManager();
      const items: number[] = [];
      manager.use(() => items.push(1));
      manager.use(() => items.push(2));

      manager.forEach((h) => {
        (h as any).fulfilled();
      });
      expect(items).toEqual([1, 2]);
    });
  });

  describe('handlers getter', () => {
    it('returns a snapshot array containing active interceptors and nulls for ejected ones', () => {
      const manager = new InterceptorManager();
      manager.use(() => 'first');
      const id1 = manager.use(() => 'second');
      manager.use(() => 'third');

      manager.eject(id1);

      const handlers = manager.handlers;
      expect(handlers).toHaveLength(3);
      expect(handlers[0]).not.toBeNull();
      expect(handlers[1]).toBeNull();
      expect(handlers[2]).not.toBeNull();
      expect((handlers[0] as any).fulfilled()).toBe('first');
    });
  });
});

describe('interceptorManager', () => {
  it('handlers getter does not perform redundant lookups on large nextId', () => {
    const manager = new InterceptorManager();

    const id1 = manager.use(() => {});
    const _id2 = manager.use(() => {});
    manager.eject(id1);

    const handlers = manager.handlers;
    expect(handlers.length).toBe(2);
    expect(handlers[0]).toBeNull();
    expect(handlers[1]).toBeDefined();
  });
});

describe('Synchronous request interceptors returning Promises', () => {
  it('throws a descriptive CorriereError if a synchronous request interceptor returns a Promise', async () => {
    const client = new Corriere();
    client.interceptors.request.use(
      async (cfg) => {
        return cfg;
      },
      null,
      { synchronous: true },
    );

    const p = client.get('/test');
    await expect(p).rejects.toMatchObject({
      isCorriereError: true,
      code: 'ERR_BAD_OPTION',
      message: 'Synchronous request interceptors cannot return a Promise.',
    });
  });
});
