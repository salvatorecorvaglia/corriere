import { beforeEach, describe, expect, it, vi } from 'vitest';
import dispatchRequest from '../src/core/request';

/**
 * `config.maxRedirects` opts into manual redirect following so that every hop is
 * re-validated against `allowedProtocols` and credentials are dropped when a redirect
 * crosses origins. Without it, fetch follows redirects itself and only the initial URL
 * is checked.
 */
describe('redirect handling', () => {
  let calls: Array<{ url: string; method: string; headers: Headers; body: any }>;

  /** Serves a scripted chain: each entry is either a redirect or a terminal response. */
  function serve(chain: Array<{ status: number; location?: string }>) {
    let index = 0;
    global.fetch = vi.fn((url: any, init: any) => {
      calls.push({
        url: String(url),
        method: init.method,
        headers: init.headers as Headers,
        body: init.body,
      });
      const step = chain[Math.min(index, chain.length - 1)];
      index++;
      const headers = new Headers({ 'content-type': 'application/json' });
      if (step.location) headers.set('location', step.location);
      return Promise.resolve(
        new Response(step.status === 204 ? null : '{"ok":true}', {
          status: step.status,
          headers,
        }),
      );
    }) as any;
  }

  const base = (extra: Record<string, unknown> = {}) => ({
    url: 'https://api.test.com/start',
    method: 'get',
    ...extra,
  });

  beforeEach(() => {
    calls = [];
  });

  it('follows a redirect chain up to maxRedirects', async () => {
    serve([
      { status: 302, location: 'https://api.test.com/one' },
      { status: 302, location: 'https://api.test.com/two' },
      { status: 200 },
    ]);
    const res = await dispatchRequest(base({ maxRedirects: 5 }));
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.test.com/start',
      'https://api.test.com/one',
      'https://api.test.com/two',
    ]);
  });

  it('throws ERR_FR_TOO_MANY_REDIRECTS when the chain is longer than maxRedirects', async () => {
    serve([{ status: 302, location: 'https://api.test.com/loop' }]);
    await expect(dispatchRequest(base({ maxRedirects: 2 }))).rejects.toMatchObject({
      code: 'ERR_FR_TOO_MANY_REDIRECTS',
    });
    expect(calls).toHaveLength(3); // initial + 2 followed hops
  });

  it('terminates on a self-referential redirect instead of looping forever', async () => {
    serve([{ status: 308, location: 'https://api.test.com/start' }]);
    await expect(dispatchRequest(base({ maxRedirects: 3 }))).rejects.toMatchObject({
      code: 'ERR_FR_TOO_MANY_REDIRECTS',
    });
  });

  it('maxRedirects: 0 returns the 3xx without following it', async () => {
    serve([{ status: 301, location: 'https://api.test.com/elsewhere' }]);
    const res = await dispatchRequest(base({ maxRedirects: 0 }));
    expect(res.status).toBe(301);
    expect(calls).toHaveLength(1);
  });

  it('re-checks the protocol allow-list on each hop', async () => {
    serve([{ status: 302, location: 'file:///etc/passwd' }]);
    await expect(dispatchRequest(base({ maxRedirects: 3 }))).rejects.toMatchObject({
      code: 'ERR_BAD_OPTION',
    });
    expect(calls).toHaveLength(1);
  });

  it('drops credential headers when a redirect crosses origins', async () => {
    serve([{ status: 302, location: 'https://evil.example.com/collect' }, { status: 200 }]);
    await dispatchRequest(
      base({
        maxRedirects: 3,
        headers: { Authorization: 'Bearer s3cret', 'X-Trace': 'keep-me' },
      }),
    );
    expect(calls[0].headers.get('authorization')).toBe('Bearer s3cret');
    expect(calls[1].headers.get('authorization')).toBeNull();
    expect(calls[1].headers.get('x-trace')).toBe('keep-me');
  });

  it('keeps credential headers on a same-origin redirect', async () => {
    serve([{ status: 302, location: 'https://api.test.com/next' }, { status: 200 }]);
    await dispatchRequest(base({ maxRedirects: 3, headers: { Authorization: 'Bearer s3cret' } }));
    expect(calls[1].headers.get('authorization')).toBe('Bearer s3cret');
  });

  it('downgrades POST to GET and drops the body on a 303', async () => {
    serve([{ status: 303, location: 'https://api.test.com/result' }, { status: 200 }]);
    await dispatchRequest(
      base({ method: 'post', data: { a: 1 }, maxRedirects: 3, url: 'https://api.test.com/submit' }),
    );
    expect(calls[0].method).toBe('POST');
    expect(calls[1].method).toBe('GET');
    expect(calls[1].body).toBeUndefined();
  });

  it('preserves method and body across a 307', async () => {
    serve([{ status: 307, location: 'https://api.test.com/result' }, { status: 200 }]);
    await dispatchRequest(
      base({ method: 'post', data: { a: 1 }, maxRedirects: 3, url: 'https://api.test.com/submit' }),
    );
    expect(calls[1].method).toBe('POST');
    expect(calls[1].body).toEqual(calls[0].body);
    expect(calls[1].body).toBeTruthy();
  });

  it('resolves a relative Location against the current URL', async () => {
    serve([{ status: 302, location: '/v2/thing' }, { status: 200 }]);
    await dispatchRequest(base({ maxRedirects: 3 }));
    expect(calls[1].url).toBe('https://api.test.com/v2/thing');
  });

  it('rejects a non-integer maxRedirects', async () => {
    serve([{ status: 200 }]);
    await expect(dispatchRequest(base({ maxRedirects: -1 }))).rejects.toMatchObject({
      code: 'ERR_BAD_OPTION_VALUE',
    });
  });

  it('leaves redirect handling to fetch when maxRedirects is unset', async () => {
    serve([{ status: 200 }]);
    await dispatchRequest(base());
    // No `redirect` override is imposed on the fetch call.
    const init = (global.fetch as any).mock.calls[0][1];
    expect(init.redirect).toBeUndefined();
  });
});
