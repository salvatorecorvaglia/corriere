import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryCache } from '../src/helpers/memoryCache';

describe('MemoryCache', () => {
  let cache: MemoryCache;

  beforeEach(() => {
    cache = new MemoryCache(3); // Small size limit to easily test eviction
  });

  it('can set and get values', () => {
    cache.set('foo', 'bar');
    expect(cache.get('foo')).toBe('bar');
  });

  it('returns null for non-existent keys', () => {
    expect(cache.get('not-found')).toBeNull();
  });

  it('respects TTL and expires entries', () => {
    vi.useFakeTimers();
    try {
      cache.set('foo', 'bar', 1000);
      expect(cache.get('foo')).toBe('bar');

      vi.advanceTimersByTime(1001);
      expect(cache.get('foo')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('proactively deletes expired items when setting a new value', () => {
    vi.useFakeTimers();
    try {
      cache.set('a', 1, 1000);
      cache.set('b', 2, 5000);

      vi.advanceTimersByTime(1500);

      // 'a' is expired. Setting 'c' should trigger eviction of 'a'.
      cache.set('c', 3);

      expect(cache.get('b')).toBe(2);
      expect(cache.get('c')).toBe(3);

      // Accessing internal map via gets to verify eviction
      expect(cache.get('a')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts the oldest item (FIFO) when limit is exceeded', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    // Limit is 3. Adding 'd' should evict 'a' (oldest).
    cache.set('d', 4);

    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('can delete entries', () => {
    cache.set('foo', 'bar');
    cache.delete('foo');
    expect(cache.get('foo')).toBeNull();
  });

  it('can clear the entire cache', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBeNull();
  });

  it('updates existing key without evicting other keys or exceeding limit', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    // Updating 'a' should keep it at 3 items and not evict 'b' or 'c'
    cache.set('a', 10);
    expect(cache.get('a')).toBe(10);
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('proactively evicts up to 5 expired items during set', () => {
    vi.useFakeTimers();
    try {
      cache = new MemoryCache(10);
      cache.set('a', 1, 100);
      cache.set('b', 2, 100);
      cache.set('c', 3, 100);
      cache.set('d', 4, 100);
      cache.set('e', 5, 100);

      vi.advanceTimersByTime(200);

      // Setting 'f' should trigger eviction of 'a' through 'e'
      cache.set('f', 6);

      expect(cache.get('a')).toBeNull();
      expect(cache.get('b')).toBeNull();
      expect(cache.get('c')).toBeNull();
      expect(cache.get('d')).toBeNull();
      expect(cache.get('e')).toBeNull();
      expect(cache.get('f')).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MemoryCache byte budgets', () => {
  it('enforces the protective default and counts shared binary backing allocations', () => {
    const cache = new MemoryCache();
    cache.set('large', 'x'.repeat(32 * 1024 * 1024));
    expect(cache.get('large')).toBeNull();
    if (typeof SharedArrayBuffer !== 'undefined') {
      const small = new MemoryCache(10, 100);
      small.set('shared', new Uint8Array(new SharedArrayBuffer(1000), 0, 1));
      expect(small.get('shared')).toBeNull();
    }
  });

  it('measures collections, binary payloads, and built-in values without serializing them', () => {
    const cache = new MemoryCache(20, 10_000);
    const values = [
      new Map([
        ['a', true],
        ['b', false],
      ]),
      new Set([1n, 2n]),
      new Blob(['payload']),
      new Date(),
      /pattern/,
      new Uint8Array([1, 2]),
      null,
    ];
    values.forEach((value, index) => {
      cache.set(String(index), value);
    });
    values.forEach((value, index) => {
      expect(cache.get(String(index))).toBe(value);
    });
    expect(cache.estimatedBytes).toBeGreaterThan(0);
    expect(cache.estimatedBytes).toBeLessThan(10_000);
    const small = new MemoryCache(10, 100);
    small.set('map', new Map([['large', 'x'.repeat(1000)]]));
    small.set('set', new Set(['x'.repeat(1000)]));
    expect(small.get('map')).toBeNull();
    expect(small.get('set')).toBeNull();
  });

  it('skips entries that exceed traversal bounds or cannot be inspected safely', () => {
    const cache = new MemoryCache();
    let nested: object = {};
    for (let depth = 0; depth < 100; depth++) nested = { nested };
    cache.set('deep', nested);
    cache.set(
      'wide',
      Array.from({ length: 10_001 }, () => 1),
    );
    cache.set(
      'proxy',
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('cannot inspect');
          },
        },
      ),
    );
    for (const key of ['deep', 'wide', 'proxy']) expect(cache.get(key)).toBeNull();
    expect(cache.estimatedBytes).toBe(0);
  });

  it('evicts by LRU when byte capacity is reached before entry count', () => {
    const cache = new MemoryCache(10, 100);
    cache.set('a', 'x'.repeat(20));
    cache.set('b', 'y'.repeat(20));
    expect(cache.estimatedBytes).toBe(84);
    cache.get('a');
    cache.set('c', 'z'.repeat(20));
    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')).not.toBeNull();
    expect(cache.get('c')).not.toBeNull();
    expect(cache.estimatedBytes).toBe(84);
  });

  it('skips oversized entries without evicting unrelated values and removes stale replacements', () => {
    const cache = new MemoryCache(10, 100);
    cache.set('a', 'small');
    cache.set('b', 'small');
    cache.set('large', 'x'.repeat(100));
    expect(cache.get('large')).toBeNull();
    cache.set('a', 'x'.repeat(100));
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBe('small');
    expect(cache.estimatedBytes).toBe(12);
  });

  it('releases accounting on replacement, expiration, deletion, and clear', () => {
    vi.useFakeTimers();
    try {
      const cache = new MemoryCache(10, 100);
      cache.set('a', 'value', 10);
      cache.set('a', 'x', 10);
      expect(cache.estimatedBytes).toBe(4);
      vi.advanceTimersByTime(11);
      expect(cache.get('a')).toBeNull();
      expect(cache.estimatedBytes).toBe(0);
      cache.set('b', 'value');
      cache.delete('b');
      cache.delete('b');
      expect(cache.estimatedBytes).toBe(0);
      cache.set('c', 'value');
      cache.clear();
      expect(cache.estimatedBytes).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accounts for backing buffers and handles cycles without invoking getters or toJSON', () => {
    const cache = new MemoryCache(10, 500);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    cache.set('cycle', cyclic);
    expect(cache.get('cycle')).toBe(cyclic);
    cache.set('slice', new Uint8Array(new ArrayBuffer(1000), 0, 1));
    expect(cache.get('slice')).toBeNull();
    const getter = vi.fn(() => 'secret');
    const value = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
    cache.set('accessor', value);
    expect(cache.get('accessor')).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    const toJSON = vi.fn(() => 'small');
    cache.set('custom', { toJSON });
    expect(cache.get('custom')).toBeNull();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('supports disabling caching or opting out of byte accounting', () => {
    const disabled = new MemoryCache(10, 0);
    disabled.set('a', 'value');
    expect(disabled.get('a')).toBeNull();
    const unlimited = new MemoryCache(10, Infinity);
    const value = { fn() {} };
    unlimited.set('a', value);
    expect(unlimited.get('a')).toBe(value);
  });

  it.each([-1, NaN, 0.5])('rejects invalid byte budgets: %s', (budget) => {
    expect(() => new MemoryCache(10, budget)).toThrow(RangeError);
  });

  it.each([0, -1, 0.5])('rejects invalid entry limits: %s', (limit) => {
    expect(() => new MemoryCache(limit)).toThrow(RangeError);
  });
});

describe('MemoryCache insertion order on update', () => {
  it('moves updated key to the end of insertion order', () => {
    const cache = new MemoryCache(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    // Updating 'a' should make it the newest insertion
    cache.set('a', 10);

    // Adding 'd' should evict 'b' (which is now the oldest) instead of 'a'
    cache.set('d', 4);

    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')).toBe(10);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });
});

/**
 * `get` did not refresh an entry's position, so eviction was first-in-first-out: a key read
 * on every request was evicted as soon as it was the oldest insert. Reads now count as use.
 */
describe('MemoryCache eviction is least-recently-used', () => {
  it('keeps an entry that was read recently and evicts the least recently used one', () => {
    const cache = new MemoryCache(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.get('a')).toBe(1);
    cache.set('d', 4);

    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });
});
