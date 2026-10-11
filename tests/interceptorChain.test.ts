import { describe, expect, it, vi } from 'vitest';
import Corriere from '../src/corriere';

function serveOk() {
  global.fetch = vi.fn(() =>
    Promise.resolve(
      new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
    ),
  ) as any;
}

/**
 * The error paths of the interceptor chain, which run like a promise chain: a handler that
 * throws hands its error to the *next* interceptor's `rejected`, and a `rejected` that
 * returns a value recovers the chain.
 */
describe('synchronous request interceptors', () => {
  it('reject a fulfilled handler that returns a promise', async () => {
    serveOk();
    const client = new Corriere();
    client.interceptors.request.use((config) => Promise.resolve(config), null, {
      synchronous: true,
    });
    await expect(client.get('https://api.test.com/x')).rejects.toMatchObject({
      code: 'ERR_BAD_OPTION',
      message: expect.stringContaining('cannot return a Promise'),
    });
  });

  it('let a later rejected handler recover from an earlier failure', async () => {
    serveOk();
    const client = new Corriere();
    // Request interceptors run in reverse registration order: `failing` runs first.
    client.interceptors.request.use(null, () => ({ url: 'https://api.test.com/recovered' }), {
      synchronous: true,
    });
    client.interceptors.request.use(
      () => {
        throw new Error('first failed');
      },
      null,
      { synchronous: true },
    );
    const res = await client.get('https://api.test.com/x');
    expect(res.data).toEqual({ ok: true });
    expect((global.fetch as any).mock.calls[0][0]).toBe('https://api.test.com/recovered');
  });

  it('reject a rejected handler that returns a promise', async () => {
    serveOk();
    const client = new Corriere();
    client.interceptors.request.use(null, (error) => Promise.reject(error), {
      synchronous: true,
    });
    client.interceptors.request.use(
      () => {
        throw new Error('first failed');
      },
      null,
      { synchronous: true },
    );
    await expect(client.get('https://api.test.com/x')).rejects.toMatchObject({
      code: 'ERR_BAD_OPTION',
    });
  });

  it('surface the error when no later handler recovers', async () => {
    serveOk();
    const client = new Corriere();
    client.interceptors.request.use(
      () => {
        throw new Error('nobody catches this');
      },
      null,
      { synchronous: true },
    );
    await expect(client.get('https://api.test.com/x')).rejects.toThrow('nobody catches this');
  });
});

describe('response interceptors', () => {
  it('pass a synchronous return value on to the next interceptor', async () => {
    serveOk();
    const client = new Corriere();
    client.interceptors.response.use((response) => response.data);
    client.interceptors.response.use((data: any) => ({ wrapped: data }));
    await expect(client.get('https://api.test.com/x')).resolves.toEqual({ wrapped: { ok: true } });
  });

  it('let a rejected handler recover synchronously from a failed request', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }),
      ),
    ) as any;
    const client = new Corriere();
    client.interceptors.response.use(null, (error: any) => ({ recovered: error.response.status }));
    await expect(client.get('https://api.test.com/x')).resolves.toEqual({ recovered: 500 });
  });

  it('let a rejected handler recover asynchronously', async () => {
    global.fetch = vi.fn(() => Promise.reject(new TypeError('network down'))) as any;
    const client = new Corriere();
    client.interceptors.response.use(null, async (error: any) => ({ recovered: error.code }));
    await expect(client.get('https://api.test.com/x')).resolves.toEqual({
      recovered: 'ERR_NETWORK',
    });
  });

  it('hand a fulfilled handler’s error to the next rejected handler', async () => {
    serveOk();
    const client = new Corriere();
    client.interceptors.response.use(() => {
      throw new Error('bad shape');
    });
    client.interceptors.response.use(null, (error: any) => `caught: ${error.message}`);
    await expect(client.get('https://api.test.com/x')).resolves.toBe('caught: bad shape');
  });
});
