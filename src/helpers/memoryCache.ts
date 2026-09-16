import type { CacheProvider } from '../types';

class MemoryCache implements CacheProvider {
  private cache = new Map<string, { value: any; expiry: number | null }>();
  private maxItems: number;

  constructor(maxItems = 1000) {
    this.maxItems = maxItems;
  }

  get(key: string) {
    const item = this.cache.get(key);
    if (!item) return null;
    if (item.expiry && Date.now() > item.expiry) {
      this.cache.delete(key);
      return null;
    }
    return item.value;
  }

  set(key: string, value: any, ttl?: number) {
    const now = Date.now();

    if (this.cache.has(key)) {
      const expiry = ttl ? now + ttl : null;
      this.cache.delete(key);
      this.cache.set(key, { value, expiry });
      return;
    }

    // Proactively evict up to 5 of the oldest items to prevent memory build-up without O(N) cost.
    // Map entries are ordered by insertion, so the oldest are checked first.
    let count = 0;
    for (const [k, item] of this.cache.entries()) {
      if (count >= 5) break;
      if (item.expiry && now > item.expiry) {
        this.cache.delete(k);
      }
      count++;
    }

    // Evict the oldest item if we are still at limit
    if (this.cache.size >= this.maxItems) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }

    const expiry = ttl ? now + ttl : null;
    this.cache.set(key, { value, expiry });
  }

  delete(key: string) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }
}

export const defaultMemoryCache = new MemoryCache();
export { MemoryCache };
