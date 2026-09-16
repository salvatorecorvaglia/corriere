import { describe, expect, it, vi } from 'vitest';
import dispatchRequest from '../src/core/request';
import corriere from '../src/index';

const TOKEN = 'super-secret-bearer-token-value';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * `error.config` was already scrubbed, but `error.response.config` is the same caller
 * config the successful path deliberately leaves intact — and an error is exactly the
 * value that ends up in logs and crash reporters. `console.error(err)` printed the
 * bearer token in cleartext.
 */
describe('credentials do not leak through an error', () => {
  const failing = () => ({
    url: 'https://api.test.com/private',
    method: 'get',
    headers: { Authorization: `Bearer ${TOKEN}`, 'X-Api-Key': 'key-12345' },
    validateStatus: (s: number) => s < 400,
  });

  it('redacts the config carried on error.response', async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse({ error: 'nope' }, 401))) as any;

    const error: any = await dispatchRequest(failing() as any).catch((e) => e);

    expect(error.isCorriereError).toBe(true);
    expect(error.response.status).toBe(401);
    expect(error.response.config.headers.Authorization).toBe('[REDACTED]');
    expect(error.response.config.headers['X-Api-Key']).toBe('[REDACTED]');
  });

  it('leaves no trace of the token anywhere in a serialized error', async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse({ error: 'nope' }, 401))) as any;

    const error: any = await dispatchRequest(failing() as any).catch((e) => e);

    // What a crash reporter or `console.error` would actually capture.
    const serialized = JSON.stringify({
      viaToJSON: error.toJSON(),
      viaConfig: error.config,
      viaResponse: error.response,
      message: error.message,
    });
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('key-12345');
  });

  it('still exposes the response payload and status', async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse({ detail: 'forbidden' }, 403))) as any;

    const error: any = await dispatchRequest(failing() as any).catch((e) => e);
    expect(error.response.data).toEqual({ detail: 'forbidden' });
    expect(error.response.status).toBe(403);
  });

  it('leaves a successful response.config readable', async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse({ ok: true }))) as any;

    const res = await dispatchRequest(failing() as any);
    // Callers legitimately read back the headers they sent on the success path.
    expect((res.config.headers as any).Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

/**
 * The cache key used to embed every header value verbatim, so a `CacheProvider` — say a
 * Redis-backed one — received a live bearer token as the key it wrote to disk.
 */
describe('cache keys are not credentials', () => {
  it('does not embed header values in the key handed to a CacheProvider', async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse({ ok: true }))) as any;

    const keys: string[] = [];
    const provider = {
      get: (k: string) => {
        keys.push(k);
        return null;
      },
      set: (k: string) => {
        keys.push(k);
      },
      delete: () => {},
      clear: () => {},
    };

    await dispatchRequest({
      url: 'https://api.test.com/thing',
      method: 'get',
      cache: provider,
      headers: { Authorization: `Bearer ${TOKEN}` },
    } as any);

    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toContain(TOKEN);
    }
  });

  it('still separates entries that differ only by header value', async () => {
    global.fetch = vi.fn((_url: string) => Promise.resolve(jsonResponse({ ok: true }))) as any;

    const store = new Map<string, unknown>();
    const provider = {
      get: (k: string) => store.get(k) ?? null,
      set: (k: string, v: unknown) => {
        store.set(k, v);
      },
      delete: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
    };

    const call = (token: string) =>
      dispatchRequest({
        url: 'https://api.test.com/thing',
        method: 'get',
        cache: provider,
        headers: { Authorization: `Bearer ${token}` },
      } as any);

    await call('alice');
    await call('bob');

    // Two distinct users must not share one cache entry.
    expect(store.size).toBe(2);
  });
});

/**
 * `autoPaginate` follows a `next` link chosen by the server it is paginating. Left
 * unchecked that walks the client — and its credentials — onto an arbitrary host.
 */
describe('autoPaginate cross-origin next links', () => {
  function servePages(pages: Record<string, unknown>) {
    const seen: Array<{ url: string; auth: string | null }> = [];
    global.fetch = vi.fn((url: string, init: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit);
      seen.push({ url, auth: headers.get('authorization') });
      const body = pages[url];
      if (!body) return Promise.resolve(jsonResponse({ error: 'no page' }, 404));
      return Promise.resolve(jsonResponse(body));
    }) as any;
    return seen;
  }

  const withAuth = (extra: Record<string, unknown> = {}) => ({
    headers: { Authorization: `Bearer ${TOKEN}` },
    ...extra,
  });

  it('refuses a next link that crosses origins', async () => {
    servePages({
      'https://api.test.com/p1': { items: [1], next: 'https://evil.test.com/steal' },
    });

    const collected: unknown[] = [];
    await expect(
      (async () => {
        for await (const item of corriere.autoPaginate('https://api.test.com/p1', withAuth())) {
          collected.push(item);
        }
      })(),
    ).rejects.toMatchObject({ code: 'ERR_BAD_OPTION' });

    // The first page's items are still yielded before the refusal.
    expect(collected).toEqual([1]);
  });

  it('follows an allow-listed cross-origin host but drops the credentials', async () => {
    const seen = servePages({
      'https://api.test.com/p1': { items: [1], next: 'https://pages.test.com/p2' },
      'https://pages.test.com/p2': { items: [2], next: null },
    });

    const collected: unknown[] = [];
    for await (const item of corriere.autoPaginate(
      'https://api.test.com/p1',
      withAuth({ allowedPaginateHosts: ['pages.test.com'] }),
    )) {
      collected.push(item);
    }

    expect(collected).toEqual([1, 2]);
    expect(seen[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(seen[1].auth).toBeNull();
  });

  it('keeps credentials on a same-origin next link', async () => {
    const seen = servePages({
      'https://api.test.com/p1': { items: [1], next: 'https://api.test.com/p2' },
      'https://api.test.com/p2': { items: [2], next: null },
    });

    const collected: unknown[] = [];
    for await (const item of corriere.autoPaginate('https://api.test.com/p1', withAuth())) {
      collected.push(item);
    }

    expect(collected).toEqual([1, 2]);
    expect(seen.every((s) => s.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('allowedPaginateHosts: null disables the check but still drops credentials', async () => {
    const seen = servePages({
      'https://api.test.com/p1': { items: [1], next: 'https://anywhere.test.com/p2' },
      'https://anywhere.test.com/p2': { items: [2], next: null },
    });

    const collected: unknown[] = [];
    for await (const item of corriere.autoPaginate(
      'https://api.test.com/p1',
      withAuth({ allowedPaginateHosts: null }),
    )) {
      collected.push(item);
    }

    expect(collected).toEqual([1, 2]);
    expect(seen[1].auth).toBeNull();
  });
});
