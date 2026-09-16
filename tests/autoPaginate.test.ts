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
