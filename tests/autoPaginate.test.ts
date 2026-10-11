import { describe, expect, it, vi } from 'vitest';
import Corriere from '../src/corriere';
import { MemoryCache } from '../src/helpers/memoryCache';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function servePages(pages: Record<string, unknown>) {
  global.fetch = vi.fn((url: any) => {
    const page = pages[String(url)];
    if (!page) return Promise.reject(new Error(`unexpected url ${url}`));
    return Promise.resolve(jsonResponse(page));
  }) as any;
}

/**
 * Consolidates `autoPaginate` coverage in one place. This is the single most-fixed function
 * in the codebase (null/non-object data, cycle guards, param preservation, custom item
 * selectors were each fixed independently in separate regression files) so it gets its own
 * dedicated suite rather than staying scattered.
 */
describe('autoPaginate', () => {
  it('yields items across pages using the default data/items/results selector', async () => {
    servePages({
      'https://api.test.com/p1': { data: [1, 2], next: 'https://api.test.com/p2' },
      'https://api.test.com/p2': { data: [3], next: null },
    });
    const client = new Corriere();
    const items: number[] = [];
    for await (const item of client.autoPaginate<number>('https://api.test.com/p1')) {
      items.push(item);
    }
    expect(items).toEqual([1, 2, 3]);
  });

  it('handles null response data gracefully', async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(null))) as any;
    const client = new Corriere();
    const items: unknown[] = [];
    for await (const item of client.autoPaginate('/test')) {
      items.push(item);
    }
    expect(items).toEqual([]);
  });

  it('handles a response whose data has none of the recognized shapes', async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse({}))) as any;
    const client = new Corriere();
    const items: unknown[] = [];
    for await (const item of client.autoPaginate('/test')) {
      items.push(item);
    }
    expect(items).toEqual([]);
  });

  it('uses a string paginateItems selector', async () => {
    servePages({
      'https://api.test.com/p1': { results: [{ id: 1 }], next: null },
    });
    const client = new Corriere();
    const items: unknown[] = [];
    for await (const item of client.autoPaginate('https://api.test.com/p1', {
      paginateItems: 'results',
    })) {
      items.push(item);
    }
    expect(items).toEqual([{ id: 1 }]);
  });

  it('uses a function paginateItems selector', async () => {
    servePages({
      'https://api.test.com/p1': { envelope: { rows: [9, 8] }, next: null },
    });
    const client = new Corriere();
    const items: unknown[] = [];
    for await (const item of client.autoPaginate('https://api.test.com/p1', {
      paginateItems: (data: any) => data.envelope.rows,
    })) {
      items.push(item);
    }
    expect(items).toEqual([9, 8]);
  });

  describe('param preservation across pages', () => {
    it('does not carry the initial page params forward once the next URL already encodes them', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: [1], next: '/test?page=2' }))
        .mockResolvedValueOnce(jsonResponse({ data: [2], next: null }));
      global.fetch = mockFetch as any;

      const client = new Corriere({ baseURL: 'https://api.test.com' });
      const items: number[] = [];
      for await (const item of client.autoPaginate<number>('/test', { params: { page: 1 } })) {
        items.push(item);
      }

      expect(items).toEqual([1, 2]);
      const secondCallUrl = String(mockFetch.mock.calls[1][0]);
      // page=2 (from the URL) must win — page=1 (the stale initial param) must not still
      // be present or silently override it.
      expect(secondCallUrl).toContain('page=2');
      expect(secondCallUrl.match(/page=/g)?.length).toBe(1);
    });

    it('does not mutate a frozen caller params object', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: [1], next: '/page2' }))
        .mockResolvedValueOnce(jsonResponse({ data: [2], next: null }));
      global.fetch = mockFetch as any;

      const client = new Corriere({ baseURL: 'https://api.test.com' });
      const frozenParams = Object.freeze({ filter: 'active' });
      const items: number[] = [];
      for await (const item of client.autoPaginate<number>('/page1', { params: frozenParams })) {
        items.push(item);
      }
      expect(items).toEqual([1, 2]);
      expect(frozenParams).toEqual({ filter: 'active' });
    });
  });

  describe('termination guards', () => {
    it('rejects a next link that points back at an already-fetched page', async () => {
      servePages({
        'https://api.test.com/p1': { items: [1], next: 'https://api.test.com/p2' },
        'https://api.test.com/p2': { items: [2], next: 'https://api.test.com/p1' },
      });
      const client = new Corriere();
      const seen: number[] = [];
      await expect(
        (async () => {
          for await (const item of client.autoPaginate<number>('https://api.test.com/p1')) {
            seen.push(item);
          }
        })(),
      ).rejects.toThrow(/Pagination cycle detected/);
      expect(seen).toEqual([1, 2]);
    });

    it('rejects a self-referential next link immediately', async () => {
      servePages({
        'https://api.test.com/loop': { items: [1], next: 'https://api.test.com/loop' },
      });
      const client = new Corriere();
      await expect(
        (async () => {
          for await (const _ of client.autoPaginate('https://api.test.com/loop')) {
            /* drain */
          }
        })(),
      ).rejects.toThrow(/Pagination cycle detected/);
    });

    it('detects a cycle even when the repeated page is referenced in a different (relative vs absolute) form', async () => {
      servePages({
        'https://api.test.com/p1': { items: [1], next: '/p2' },
        'https://api.test.com/p2': { items: [2], next: 'https://api.test.com/p1' },
      });
      const client = new Corriere({ baseURL: 'https://api.test.com' });
      const seen: number[] = [];
      await expect(
        (async () => {
          for await (const item of client.autoPaginate<number>('https://api.test.com/p1')) {
            seen.push(item);
          }
        })(),
      ).rejects.toThrow(/Pagination cycle detected/);
      expect(seen).toEqual([1, 2]);
    });

    it('stops at maxPages on a non-repeating but endless chain', async () => {
      let n = 0;
      global.fetch = vi.fn(() => {
        n++;
        return Promise.resolve(
          jsonResponse({ items: [n], next: `https://api.test.com/page/${n + 1}` }),
        );
      }) as any;

      const client = new Corriere();
      await expect(
        (async () => {
          for await (const _ of client.autoPaginate('https://api.test.com/page/0', {
            maxPages: 4,
          })) {
            /* drain */
          }
        })(),
      ).rejects.toThrow(/exceeded maxPages \(4\)/);
      expect(n).toBe(4);
    });
  });

  describe('interaction with cache and dedupe', () => {
    it('paginates correctly when cache is enabled, without yielding stale duplicate pages', async () => {
      servePages({
        'https://api.test.com/p1': { data: [1, 2], next: 'https://api.test.com/p2' },
        'https://api.test.com/p2': { data: [3], next: null },
      });
      const client = new Corriere();
      const cache = new MemoryCache();
      const items: number[] = [];
      for await (const item of client.autoPaginate<number>('https://api.test.com/p1', {
        cache,
      })) {
        items.push(item);
      }
      expect(items).toEqual([1, 2, 3]);

      // Paginating the exact same chain again reuses the cache rather than re-fetching,
      // and still yields the same items in the same order.
      const fetchCallsBefore = (global.fetch as any).mock.calls.length;
      const secondItems: number[] = [];
      for await (const item of client.autoPaginate<number>('https://api.test.com/p1', {
        cache,
      })) {
        secondItems.push(item);
      }
      expect(secondItems).toEqual([1, 2, 3]);
      expect((global.fetch as any).mock.calls.length).toBe(fetchCallsBefore);
    });

    it('paginates correctly when dedupe is enabled', async () => {
      servePages({
        'https://api.test.com/p1': { data: [1], next: 'https://api.test.com/p2' },
        'https://api.test.com/p2': { data: [2], next: null },
      });
      const client = new Corriere();
      const items: number[] = [];
      for await (const item of client.autoPaginate<number>('https://api.test.com/p1', {
        dedupe: true,
      })) {
        items.push(item);
      }
      expect(items).toEqual([1, 2]);
    });
  });

  describe('network failure mid-chain', () => {
    it('propagates a network error from a later page instead of swallowing it', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ data: [1], next: 'https://api.test.com/p2' }))
        .mockRejectedValueOnce(new TypeError('network down'));
      global.fetch = mockFetch as any;

      const client = new Corriere();
      const seen: number[] = [];
      await expect(
        (async () => {
          for await (const item of client.autoPaginate<number>('https://api.test.com/p1')) {
            seen.push(item);
          }
        })(),
      ).rejects.toMatchObject({ code: 'ERR_NETWORK' });

      // The first page's items were already yielded before the failure.
      expect(seen).toEqual([1]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});

describe('autoPaginate with null or non-object response data', () => {
  it('handles null response data gracefully', async () => {
    const client = new Corriere();
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve('null'),
    });
    global.fetch = mockFetch;

    const items: any[] = [];
    for await (const item of client.autoPaginate('/test')) {
      items.push(item);
    }

    expect(items).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('handles empty/non-object response data gracefully', async () => {
    const client = new Corriere();
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve('{}'),
    });
    global.fetch = mockFetch;

    const items: any[] = [];
    for await (const item of client.autoPaginate('/test')) {
      items.push(item);
    }

    expect(items).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('paginates when valid data is present', async () => {
    const client = new Corriere();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: () => Promise.resolve(JSON.stringify({ data: [1, 2], next: '/page2' })),
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: () => Promise.resolve(JSON.stringify({ data: [3], next: null })),
      });
    global.fetch = mockFetch;

    const items: any[] = [];
    for await (const item of client.autoPaginate('/test')) {
      items.push(item);
    }

    expect(items).toEqual([1, 2, 3]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('autoPaginate parameter preservation', () => {
  it('should not preserve initial params across pages', async () => {
    const client = new Corriere();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: () => Promise.resolve(JSON.stringify({ data: [1], next: '/page2?page=2' })),
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: () => Promise.resolve(JSON.stringify({ data: [2], next: null })),
      });
    global.fetch = mockFetch;

    const items: any[] = [];
    for await (const item of client.autoPaginate('/test', { params: { page: 1 } })) {
      items.push(item);
    }

    expect(items).toEqual([1, 2]);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('page=1'),
      expect.anything(),
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/page2?page=2'),
      expect.anything(),
    );
    expect(mockFetch.mock.calls[1][0]).not.toContain('page=1');
  });
});

describe('autoPaginate', () => {
  it('does not mutate frozen caller params object', async () => {
    const client = new Corriere();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: () =>
          Promise.resolve(JSON.stringify({ data: [1], next: 'http://test.com/page2?page=2' })),
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: () => Promise.resolve(JSON.stringify({ data: [2], next: null })),
      });
    global.fetch = mockFetch;

    const frozenParams = Object.freeze({ page: 1, limit: 10 });
    const items: any[] = [];
    for await (const item of client.autoPaginate('http://test.com/page1', {
      params: frozenParams,
    })) {
      items.push(item);
    }

    expect(items).toEqual([1, 2]);
    expect(frozenParams.page).toBe(1);
  });
});

describe('autoPaginate parameter preservation and custom items selectors', () => {
  it('preserves persistent query params while stripping pagination overlaps', async () => {
    const client = new Corriere();
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: () => Promise.resolve(JSON.stringify({ data: [1], next: '/page2?page=2' })),
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        text: () => Promise.resolve(JSON.stringify({ data: [2], next: null })),
      });
    global.fetch = mockFetch;

    const items: any[] = [];
    const generator = client.autoPaginate('/test', {
      params: { apiKey: 'secret-key', page: 1 },
    });

    for await (const item of generator) {
      items.push(item);
    }

    expect(items).toEqual([1, 2]);

    // First call should have page=1 and apiKey=secret-key
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('apiKey=secret-key'),
      expect.anything(),
    );
    expect(mockFetch.mock.calls[0][0]).toContain('page=1');

    // Second call should have page=2 from nextUrl, and KEEP apiKey=secret-key, but REMOVE page=1
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/page2?page=2'),
      expect.anything(),
    );
    expect(mockFetch.mock.calls[1][0]).toContain('apiKey=secret-key');
    expect(mockFetch.mock.calls[1][0]).not.toContain('page=1');
  });

  it('supports custom string-based item key pagination extraction', async () => {
    const client = new Corriere();
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ results: [100, 200] })),
    });

    const items: any[] = [];
    for await (const item of client.autoPaginate('/test', { paginateItems: 'results' })) {
      items.push(item);
    }

    expect(items).toEqual([100, 200]);
  });

  it('supports custom function-based item pagination extraction', async () => {
    const client = new Corriere();
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve(JSON.stringify({ nested: { array: ['foo', 'bar'] } })),
    });

    const items: any[] = [];
    for await (const item of client.autoPaginate('/test', {
      paginateItems: (data) => data.nested.array,
    })) {
      items.push(item);
    }

    expect(items).toEqual(['foo', 'bar']);
  });
});

describe('autoPaginate termination guards', () => {
  function servePages(pages: Record<string, unknown>) {
    global.fetch = vi.fn((url: any) => {
      const page = pages[String(url)];
      if (!page) throw new Error(`unexpected url ${url}`);
      return Promise.resolve(jsonResponse(page));
    }) as any;
  }

  it('rejects a next link that points back at an already-fetched page', async () => {
    servePages({
      'https://api.test.com/p1': { items: [1], next: 'https://api.test.com/p2' },
      'https://api.test.com/p2': { items: [2], next: 'https://api.test.com/p1' },
    });

    const client = new Corriere();
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const item of client.autoPaginate<number>('https://api.test.com/p1')) {
          seen.push(item);
        }
      })(),
    ).rejects.toThrow(/Pagination cycle detected/);

    // It still yielded the real pages before detecting the cycle.
    expect(seen).toEqual([1, 2]);
  });

  it('rejects a self-referential next link immediately', async () => {
    servePages({
      'https://api.test.com/loop': { items: [1], next: 'https://api.test.com/loop' },
    });
    const client = new Corriere();
    await expect(
      (async () => {
        for await (const _ of client.autoPaginate('https://api.test.com/loop')) {
          /* drain */
        }
      })(),
    ).rejects.toThrow(/Pagination cycle detected/);
  });

  it('stops at maxPages on a non-repeating but endless chain', async () => {
    let n = 0;
    global.fetch = vi.fn(() => {
      n++;
      return Promise.resolve(
        jsonResponse({ items: [n], next: `https://api.test.com/page/${n + 1}` }),
      );
    }) as any;

    const client = new Corriere();
    await expect(
      (async () => {
        for await (const _ of client.autoPaginate('https://api.test.com/page/0', {
          maxPages: 4,
        })) {
          /* drain */
        }
      })(),
    ).rejects.toThrow(/exceeded maxPages \(4\)/);
    expect(n).toBe(4);
  });

  it('completes normally when the chain ends', async () => {
    servePages({
      'https://api.test.com/a': { items: [1, 2], next: 'https://api.test.com/b' },
      'https://api.test.com/b': { items: [3], next: null },
    });
    const client = new Corriere();
    const seen: number[] = [];
    for await (const item of client.autoPaginate<number>('https://api.test.com/a')) {
      seen.push(item);
    }
    expect(seen).toEqual([1, 2, 3]);
  });
});

/**
 * Credentials used to be stripped from the per-call config only. `request()` then merged the
 * instance defaults back in, and request interceptors ran afterwards, so an instance-level
 * `Authorization` header, instance `auth`, an interceptor-added token and `withCredentials`
 * all reached the foreign host a server-chosen `next` link pointed at.
 */
describe('autoPaginate cross-origin credential stripping', () => {
  type Seen = { url: string; authorization: string | null; credentials?: RequestCredentials };

  function serveCrossOrigin(): Seen[] {
    const seen: Seen[] = [];
    global.fetch = vi.fn((url: any, init: RequestInit) => {
      seen.push({
        url: String(url),
        authorization: new Headers(init.headers).get('authorization'),
        credentials: init.credentials,
      });
      return Promise.resolve(
        String(url).startsWith('https://api.test.com')
          ? jsonResponse({ items: [1], next: 'https://other.test.com/p2' })
          : jsonResponse({ items: [2], next: null }),
      );
    }) as any;
    return seen;
  }

  async function drain(client: Corriere, config: Record<string, unknown> = {}) {
    const items: unknown[] = [];
    for await (const item of client.autoPaginate('https://api.test.com/p1', {
      allowedPaginateHosts: ['other.test.com'],
      ...config,
    })) {
      items.push(item);
    }
    return items;
  }

  it('drops an instance-level Authorization header on the foreign hop', async () => {
    const seen = serveCrossOrigin();
    const client = new Corriere({ headers: { Authorization: 'Bearer SECRET' } });
    expect(await drain(client)).toEqual([1, 2]);
    expect(seen[0].authorization).toBe('Bearer SECRET');
    expect(seen[1].url).toBe('https://other.test.com/p2');
    expect(seen[1].authorization).toBeNull();
  });

  it('drops instance-level basic auth on the foreign hop', async () => {
    const seen = serveCrossOrigin();
    const client = new Corriere({ auth: { username: 'u', password: 'p' } });
    await drain(client);
    expect(seen[0].authorization).toMatch(/^Basic /);
    expect(seen[1].authorization).toBeNull();
  });

  it('drops a token added by a request interceptor on the foreign hop', async () => {
    const seen = serveCrossOrigin();
    const client = new Corriere();
    client.interceptors.request.use((config: any) => ({
      ...config,
      headers: { ...config.headers, Authorization: 'Bearer FROM_INTERCEPTOR' },
    }));
    await drain(client);
    expect(seen[0].authorization).toBe('Bearer FROM_INTERCEPTOR');
    expect(seen[1].authorization).toBeNull();
  });

  it('stops sending cookies (withCredentials) on the foreign hop', async () => {
    const seen = serveCrossOrigin();
    const client = new Corriere({ withCredentials: true });
    await drain(client);
    expect(seen[0].credentials).toBe('include');
    expect(seen[1].credentials).not.toBe('include');
  });

  it('keeps credentials on same-origin pages', async () => {
    const seen: Seen[] = [];
    global.fetch = vi.fn((url: any, init: RequestInit) => {
      seen.push({
        url: String(url),
        authorization: new Headers(init.headers).get('authorization'),
      });
      return Promise.resolve(
        String(url).endsWith('/p1')
          ? jsonResponse({ items: [1], next: 'https://api.test.com/p2' })
          : jsonResponse({ items: [2], next: null }),
      );
    }) as any;
    const client = new Corriere({ headers: { Authorization: 'Bearer SECRET' } });
    for await (const _ of client.autoPaginate('https://api.test.com/p1')) {
      // drain
    }
    expect(seen.map((s) => s.authorization)).toEqual(['Bearer SECRET', 'Bearer SECRET']);
  });
});

/**
 * `autoPaginate` read its options from the per-call config only, so the same options set
 * on the instance were silently ignored.
 */
describe('autoPaginate honours instance-level options', () => {
  it('uses an instance-level paginateItems selector', async () => {
    servePages({
      'https://api.test.com/p1': { rows: [1, 2], next: 'https://api.test.com/p2' },
      'https://api.test.com/p2': { rows: [3], next: null },
    });
    const client = new Corriere({ paginateItems: 'rows' });
    const items: number[] = [];
    for await (const item of client.autoPaginate<number>('https://api.test.com/p1')) {
      items.push(item);
    }
    expect(items).toEqual([1, 2, 3]);
  });

  it('uses an instance-level maxPages', async () => {
    let n = 0;
    global.fetch = vi.fn(() => {
      n++;
      return Promise.resolve(jsonResponse({ items: [n], next: `https://api.test.com/p${n + 1}` }));
    }) as any;
    const client = new Corriere({ maxPages: 2 });
    const iterate = async () => {
      for await (const _ of client.autoPaginate('https://api.test.com/p1')) {
        // drain
      }
    };
    await expect(iterate()).rejects.toThrow(/maxPages \(2\)/);
    expect(n).toBe(2);
  });

  it('uses an instance-level allowedPaginateHosts', async () => {
    servePages({
      'https://api.test.com/p1': { items: [1], next: 'https://other.test.com/p2' },
      'https://other.test.com/p2': { items: [2], next: null },
    });
    const client = new Corriere({ allowedPaginateHosts: ['other.test.com'] });
    const items: number[] = [];
    for await (const item of client.autoPaginate<number>('https://api.test.com/p1')) {
      items.push(item);
    }
    expect(items).toEqual([1, 2]);
  });

  it('lets a per-call option override the instance one', async () => {
    servePages({
      'https://api.test.com/p1': { rows: [1], other: [9], next: null },
    });
    const client = new Corriere({ paginateItems: 'rows' });
    const items: number[] = [];
    for await (const item of client.autoPaginate<number>('https://api.test.com/p1', {
      paginateItems: 'other',
    })) {
      items.push(item);
    }
    expect(items).toEqual([9]);
  });
});

/**
 * Two layers keep these credentials off the wire: `withoutCredentials` scrubs the per-call
 * config (grouped headers included), and the `_stripCredentials` flag strips the final
 * headers at the transport. This test asserts the outcome, so it holds while either layer
 * works — it cannot single one out.
 */
describe('autoPaginate cross-origin stripping of grouped headers', () => {
  it('drops credentials nested in per-method header groups of the per-call config', async () => {
    const seen: Array<string | null> = [];
    global.fetch = vi.fn((url: any, init: RequestInit) => {
      seen.push(new Headers(init.headers).get('authorization'));
      return Promise.resolve(
        String(url).startsWith('https://api.test.com')
          ? jsonResponse({ items: [1], next: 'https://other.test.com/p2' })
          : jsonResponse({ items: [2], next: null }),
      );
    }) as any;

    const client = new Corriere();
    for await (const _ of client.autoPaginate('https://api.test.com/p1', {
      allowedPaginateHosts: ['other.test.com'],
      headers: { common: { Authorization: 'Bearer A' }, get: { 'X-Keep': 'yes' } },
    })) {
      // drain
    }
    expect(seen).toEqual(['Bearer A', null]);
  });
});
