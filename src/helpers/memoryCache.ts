import type { CacheProvider } from '../types';
import { estimateValueBytes } from './estimateValueBytes';

export const DEFAULT_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * An in-memory `CacheProvider` bounded by entry count and estimated payload bytes.
 * Byte estimates exclude opaque transport handles. When full, the least
 * recently used entry is evicted: the `Map` keeps entries in insertion order, and both
 * `set` and a successful `get` move an entry to the end.
 */
class MemoryCache implements CacheProvider {
  private cache = new Map<string, { value: any; expiry: number | null; bytes: number }>();
  private maxItems: number;
  private maxBytes: number;
  private retainedBytes = 0;

  constructor(maxItems = 1000, maxBytes = DEFAULT_CACHE_MAX_BYTES) {
    if (maxItems !== Infinity && (!Number.isSafeInteger(maxItems) || maxItems < 1)) {
      throw new RangeError('maxItems must be a positive safe integer or Infinity');
    }
    if (maxBytes !== Infinity && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      throw new RangeError('maxBytes must be a non-negative safe integer or Infinity');
    }
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
  }

  get estimatedBytes(): number {
    return this.retainedBytes;
  }

  get(key: string) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (item.expiry && Date.now() > item.expiry) {
      this.delete(key);
      return null;
    }
    // Re-inserted so a read counts as use: eviction takes from the front of the Map.
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.value;
  }

  set(key: string, value: any, ttl?: number) {
    const now = Date.now();

    const bytes =
      this.maxBytes === Infinity ? 0 : key.length * 2 + estimateValueBytes(value, this.maxBytes);
    this.delete(key);
    // Updating an entry must not leave an older, stale value behind if it no longer fits.
    if (this.maxBytes === 0 || bytes > this.maxBytes) return;

    // Proactively evict up to 5 of the oldest items to prevent memory build-up without O(N) cost.
    // Map entries are ordered by insertion, so the oldest are checked first.
    let count = 0;
    for (const [k, item] of this.cache.entries()) {
      if (count >= 5) break;
      if (item.expiry && now > item.expiry) {
        this.delete(k);
      }
      count++;
    }

    // Evict the least recently used item if we are still at the limit
    while (this.cache.size >= this.maxItems || this.retainedBytes + bytes > this.maxBytes) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.delete(oldest);
      }
    }

    const expiry = ttl ? now + ttl : null;
    this.cache.set(key, { value, expiry, bytes });
    this.retainedBytes += bytes;
  }

  delete(key: string) {
    const item = this.cache.get(key);
    if (item) this.retainedBytes -= item.bytes;
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
    this.retainedBytes = 0;
  }
}

export { MemoryCache };
