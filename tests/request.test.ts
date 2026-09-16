import { beforeEach, describe, expect, it, vi } from 'vitest';
import dispatchRequest from '../src/core/request';
import Corriere from '../src/corriere';

describe('dispatchRequest (request.ts)', () => {
  let dispatchRequest: any;

  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    const mod = await import('../src/core/request');
    dispatchRequest = mod.default;
  });

  function mockFetch(data: any, options: any = {}) {
    const {
      status = 200,
      statusText = 'OK',
      headers = new Headers({ 'content-type': 'application/json' }),
    } = options;

    const body = typeof data === 'string' ? data : JSON.stringify(data);

    global.fetch = vi.fn(() =>
      Promise.resolve({
        status,
        statusText,
        headers,
        text: () => Promise.resolve(body),
        json: () => Promise.resolve(typeof data === 'object' ? data : JSON.parse(data)),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        blob: () => Promise.resolve(new Blob([body])),
        body: null,
      }),
    ) as any;
  }

  describe('basic requests', () => {
    it('makes a GET request', async () => {
      mockFetch({ users: [] });

      const response = await dispatchRequest({
        url: 'https://api.test.com/users',
        method: 'get',
        headers: {},
        transformResponse: [
          (data: any) => (typeof data === 'string' ? JSON.parse(data as string) : data),
        ],
      });

      expect(response.status).toBe(200);
      expect(response.data).toEqual({ users: [] });
    });

    it('makes a POST request with data', async () => {
      mockFetch({ id: 1 });
      const postData = { name: 'John' };

      const response = await dispatchRequest({
        url: 'https://api.test.com/users',
        method: 'post',
        headers: {},
        data: postData,
      });

      expect(response.status).toBe(200);
    });

    it('includes duration in response', async () => {
      mockFetch({ ok: true });

      const response = await dispatchRequest({
        url: 'https://api.test.com/test',
        method: 'get',
        headers: {},
      });

      expect(response.duration).toBeDefined();
      expect(typeof response.duration).toBe('number');
    });

    it('applies transformResponse for JSON by default', async () => {
      mockFetch({ users: [] });

      const response = await dispatchRequest({
        url: 'https://api.test.com/users',
        method: 'get',
        headers: {},
        transformResponse: [
          (data: any) => (typeof data === 'string' ? JSON.parse(data as string) : data),
        ],
      });

      expect(response.data).toEqual({ users: [] });
    });
  });

  describe('headers', () => {
    it('merges common headers', async () => {
      mockFetch({});
      await dispatchRequest({
        url: 'https://api.test.com/test',
        method: 'get',
        headers: {
          common: { Accept: 'text/html' },
          get: {},
        },
      });

      const fetchCall = vi.mocked(global.fetch).mock.calls[0];
      const fetchOptions = fetchCall[1] as RequestInit;
      expect((fetchOptions.headers as Headers).get('accept')).toBe('text/html');
    });

    it('removes Content-Type for FormData', async () => {
      mockFetch({});
      const formData = new FormData();

      await dispatchRequest({
        url: 'https://api.test.com/upload',
        method: 'post',
        headers: { 'Content-Type': 'application/json' },
        data: formData,
      });

      const fetchCall = vi.mocked(global.fetch).mock.calls[0];
      const fetchOptions = fetchCall[1] as RequestInit;
      expect((fetchOptions.headers as Headers).has('content-type')).toBe(false);
    });
  });

  describe('authentication', () => {
    it('adds Basic auth header', async () => {
      mockFetch({});

      await dispatchRequest({
        url: 'https://api.test.com/test',
        method: 'get',
        headers: {},
        auth: { username: 'user', password: 'pass' },
      });

      const fetchCall = vi.mocked(global.fetch).mock.calls[0];
      const fetchOptions = fetchCall[1] as RequestInit;
      expect((fetchOptions.headers as Headers).get('authorization')).toBe('Basic dXNlcjpwYXNz');
    });
  });

  describe('responseType', () => {
    it('parses JSON by default', async () => {
      mockFetch({ message: 'hello' });

      const response = await dispatchRequest({
        url: 'https://api.test.com/test',
        method: 'get',
        headers: {},
        transformResponse: [
          (data: any) => (typeof data === 'string' ? JSON.parse(data as string) : data),
        ],
      });

      expect(response.data).toEqual({ message: 'hello' });
    });

    it('returns text when responseType is text', async () => {
      mockFetch('plain text', { headers: new Headers({ 'content-type': 'text/plain' }) });

      const response = await dispatchRequest({
        url: 'https://api.test.com/test',
        method: 'get',
        headers: {},
        responseType: 'text',
      });

      expect(response.data).toBe('plain text');
    });
  });

  describe('error handling', () => {
    it('rejects on 4xx status', async () => {
      mockFetch({ error: 'Not Found' }, { status: 404 });

      await expect(
        dispatchRequest({
          url: 'https://api.test.com/test',
          method: 'get',
          headers: {},
          validateStatus: (status: number) => status >= 200 && status < 300,
        }),
      ).rejects.toThrow('Request failed with status code 404');
    });

    it('resolves on 2xx when validateStatus returns true', async () => {
      mockFetch({ ok: true }, { status: 201 });

      const response = await dispatchRequest({
        url: 'https://api.test.com/test',
        method: 'post',
        headers: {},
        validateStatus: () => true,
      });

      expect(response.status).toBe(201);
    });
  });

  describe('timeout', () => {
    it('creates AbortController for timeout', async () => {
      mockFetch({});

      await dispatchRequest({
        url: 'https://api.test.com/test',
        method: 'get',
        headers: {},
        timeout: 5000,
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    });
  });

  describe('abort classification (M1)', () => {
    it('classifies user-abort with non-AbortError reason as ERR_CANCELED', async () => {
      global.fetch = vi.fn((_url, init: any) => {
        return new Promise((_resolve, reject) => {
          const fail = () => {
            const err = new Error('user cancelled');
            err.name = 'CustomCancel';
            reject(err);
          };
          if (init.signal?.aborted) {
            queueMicrotask(fail);
            return;
          }
          init.signal?.addEventListener('abort', fail, { once: true });
        });
      }) as any;

      const controller = new AbortController();
      const p = dispatchRequest({
        url: 'https://api.test.com/slow',
        method: 'get',
        headers: {},
        signal: controller.signal,
        timeout: 10_000,
      });
      controller.abort(new Error('user cancelled'));
      await expect(p).rejects.toMatchObject({
        isCorriereError: true,
        code: 'ERR_CANCELED',
      });
    });

    it('still classifies timeout as ETIMEDOUT', async () => {
      global.fetch = vi.fn((_url, init: any) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }) as any;

      await expect(
        dispatchRequest({
          url: 'https://api.test.com/slow',
          method: 'get',
          headers: {},
          timeout: 5,
        }),
      ).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    });
  });

  describe('invalid URL classification (M3)', () => {
    it('throws ERR_INVALID_URL up front for malformed URLs', async () => {
      mockFetch({});
      await expect(
        dispatchRequest({ url: 'http://exa mple.com/x', method: 'get', headers: {} }),
      ).rejects.toMatchObject({
        isCorriereError: true,
        code: 'ERR_INVALID_URL',
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('TypeError "fetch failed" from network layer is ERR_NETWORK, not ERR_INVALID_URL', async () => {
      global.fetch = vi.fn(() => Promise.reject(new TypeError('fetch failed'))) as any;
      await expect(
        dispatchRequest({ url: 'https://api.test.com/x', method: 'get', headers: {} }),
      ).rejects.toMatchObject({ code: 'ERR_NETWORK' });
    });
  });

  describe('protocol allow-list', () => {
    it('rejects file: URLs by default', async () => {
      mockFetch({});
      await expect(
        dispatchRequest({ url: 'file:///etc/passwd', method: 'get', headers: {} }),
      ).rejects.toMatchObject({
        isCorriereError: true,
        code: 'ERR_BAD_OPTION',
        message: expect.stringContaining('file:'),
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('rejects javascript: URLs by default', async () => {
      mockFetch({});
      await expect(
        dispatchRequest({ url: 'javascript:alert(1)', method: 'get', headers: {} }),
      ).rejects.toMatchObject({ code: 'ERR_BAD_OPTION' });
    });

    it('allows http and https by default', async () => {
      mockFetch({ ok: true });
      const res = await dispatchRequest({
        url: 'http://api.test.com/x',
        method: 'get',
        headers: {},
        transformResponse: [(d: any) => (typeof d === 'string' ? JSON.parse(d) : d)],
      });
      expect(res.status).toBe(200);
    });

    it('allows opting into additional protocols', async () => {
      mockFetch({ ok: true });
      const res = await dispatchRequest({
        url: 'ws://api.test.com/x',
        method: 'get',
        headers: {},
        allowedProtocols: ['http:', 'https:', 'ws:'],
        transformResponse: [(d: any) => (typeof d === 'string' ? JSON.parse(d) : d)],
      });
      expect(res.status).toBe(200);
    });

    it('disables the check when allowedProtocols is null', async () => {
      mockFetch({ ok: true });
      const res = await dispatchRequest({
        url: 'file:///tmp/x',
        method: 'get',
        headers: {},
        allowedProtocols: null,
        transformResponse: [(d: any) => (typeof d === 'string' ? JSON.parse(d) : d)],
      });
      expect(res.status).toBe(200);
    });

    it('allows scheme-less (relative) URLs', async () => {
      mockFetch({ ok: true });
      const res = await dispatchRequest({
        url: '/api/x',
        method: 'get',
        headers: {},
        transformResponse: [(d: any) => (typeof d === 'string' ? JSON.parse(d) : d)],
      });
      expect(res.status).toBe(200);
    });

    it('rejects header values containing CRLF', async () => {
      mockFetch({});
      await expect(
        dispatchRequest({
          url: 'https://api.test.com/x',
          method: 'get',
          headers: { 'X-Custom': 'foo\r\nInjected: yes' },
        }),
      ).rejects.toMatchObject({
        isCorriereError: true,
        code: 'ERR_BAD_OPTION',
        message: expect.stringContaining('CR, LF and NUL'),
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('rejects header names containing CRLF or NUL', async () => {
      mockFetch({});
      await expect(
        dispatchRequest({
          url: 'https://api.test.com/x',
          method: 'get',
          headers: { 'X-Bad\nName': 'safe' },
        }),
      ).rejects.toMatchObject({ code: 'ERR_BAD_OPTION' });
    });

    it('returns the caller config unredacted on a successful response', async () => {
      mockFetch({ ok: true });
      const res = await dispatchRequest({
        url: 'https://api.test.com/x',
        method: 'get',
        headers: { Authorization: 'Bearer s3cret' },
        auth: { username: 'u', password: 'p' },
        transformResponse: [(d: any) => (typeof d === 'string' ? JSON.parse(d) : d)],
      });
      // Callers must be able to read back the headers they sent. Redaction applies to
      // errors, which are what end up in logs and crash reporters.
      expect((res.config.headers as any).Authorization).toBe('Bearer s3cret');
    });

    it('redacts credentials on the error path instead', async () => {
      mockFetch({ nope: true }, { status: 500 });
      const err: any = await dispatchRequest({
        url: 'https://api.test.com/x',
        method: 'post',
        headers: { Authorization: 'Bearer s3cret' },
        data: { user: 'u', password: 'hunter2' },
        validateStatus: (s: number) => s >= 200 && s < 300,
      }).catch((e: any) => e);

      expect(err.isCorriereError).toBe(true);
      expect((err.config.headers as any).Authorization).toBe('[REDACTED]');
      expect((err.config.data as any).password).toBe('[REDACTED]');
      expect((err.config.data as any).user).toBe('u');
      expect(JSON.stringify(err.toJSON())).not.toContain('hunter2');
    });

    it('preserves raw body in error when JSON parse fails', async () => {
      global.fetch = vi.fn(() =>
        Promise.resolve({
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve('not-json-{'),
          json: () => Promise.reject(new SyntaxError('Unexpected token')),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
          blob: () => Promise.resolve(new Blob()),
          body: null,
        } as any),
      ) as any;

      await expect(
        dispatchRequest({ url: 'https://api.test.com/bad', method: 'get', headers: {} }),
      ).rejects.toMatchObject({
        isCorriereError: true,
        code: 'ERR_BAD_RESPONSE',
        message: expect.stringContaining('not-json-{'),
      });
    });

    it('dedupes concurrent GETs and clears the entry on settle', async () => {
      let fetchCalls = 0;
      global.fetch = vi.fn(() => {
        fetchCalls++;
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                status: 200,
                statusText: 'OK',
                headers: new Headers({ 'content-type': 'application/json' }),
                text: () => Promise.resolve('{"ok":true}'),
                json: () => Promise.resolve({ ok: true }),
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
                blob: () => Promise.resolve(new Blob()),
                body: null,
              } as any),
            5,
          ),
        );
      }) as any;

      const base = {
        url: 'https://api.test.com/same',
        method: 'get',
        headers: {},
        dedupe: true,
      } as any;
      const [a, b] = await Promise.all([dispatchRequest(base), dispatchRequest(base)]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(fetchCalls).toBe(1);

      // Subsequent identical request after settle must trigger a fresh fetch (entry cleaned up).
      await dispatchRequest(base);
      expect(fetchCalls).toBe(2);
    });

    it('does not share dedupe slot across different Authorization headers (H1)', async () => {
      let fetchCalls = 0;
      global.fetch = vi.fn(() => {
        fetchCalls++;
        return new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                status: 200,
                statusText: 'OK',
                headers: new Headers({ 'content-type': 'application/json' }),
                text: () => Promise.resolve('{"ok":true}'),
                json: () => Promise.resolve({ ok: true }),
                arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
                blob: () => Promise.resolve(new Blob()),
                body: null,
              } as any),
            5,
          ),
        );
      }) as any;

      const base = {
        url: 'https://api.test.com/me',
        method: 'get',
        dedupe: true,
      } as any;
      await Promise.all([
        dispatchRequest({ ...base, headers: { Authorization: 'Bearer alice' } }),
        dispatchRequest({ ...base, headers: { Authorization: 'Bearer bob' } }),
      ]);
      expect(fetchCalls).toBe(2);
    });

    it('does not share cache entry across different Accept headers (H1)', async () => {
      const cache = new Map<string, any>();
      const provider = {
        get: (k: string) => cache.get(k),
        set: (k: string, v: any) => cache.set(k, v),
      };
      let fetchCalls = 0;
      global.fetch = vi.fn(() => {
        fetchCalls++;
        return Promise.resolve({
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve('{"ok":true}'),
          json: () => Promise.resolve({ ok: true }),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
          blob: () => Promise.resolve(new Blob()),
          body: null,
        } as any);
      }) as any;

      const base = {
        url: 'https://api.test.com/thing',
        method: 'get',
        cache: provider,
      } as any;
      await dispatchRequest({ ...base, headers: { Accept: 'application/json' } });
      await dispatchRequest({ ...base, headers: { Accept: 'application/xml' } });
      expect(fetchCalls).toBe(2);
    });

    it('gives each dedupe consumer an independent config view (H2)', async () => {
      global.fetch = vi.fn(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  status: 200,
                  statusText: 'OK',
                  headers: new Headers({ 'content-type': 'application/json' }),
                  text: () => Promise.resolve('{"ok":true}'),
                  json: () => Promise.resolve({ ok: true }),
                  arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
                  blob: () => Promise.resolve(new Blob()),
                  body: null,
                } as any),
              5,
            ),
          ),
      ) as any;

      const baseUrl = 'https://api.test.com/shared';
      const a = dispatchRequest({
        url: baseUrl,
        method: 'get',
        dedupe: true,
        headers: { Authorization: 'Bearer X' },
        meta: { caller: 'A' },
      } as any);
      const b = dispatchRequest({
        url: baseUrl,
        method: 'get',
        dedupe: true,
        headers: { Authorization: 'Bearer X' },
        meta: { caller: 'B' },
      } as any);
      const [respA, respB] = await Promise.all([a, b]);

      expect(respA).not.toBe(respB);
      expect((respA.config as any).meta.caller).toBe('A');
      expect((respB.config as any).meta.caller).toBe('B');
      // Each consumer sees its own config, unredacted (redaction is error-only).
      expect((respA.config as any).headers.Authorization).toBe('Bearer X');
    });

    it('clears dedupe entry on rejection', async () => {
      let fetchCalls = 0;
      global.fetch = vi.fn(() => {
        fetchCalls++;
        return Promise.reject(new TypeError('network down'));
      }) as any;

      const base = {
        url: 'https://api.test.com/fail',
        method: 'get',
        headers: {},
        dedupe: true,
      } as any;
      await expect(dispatchRequest(base)).rejects.toBeDefined();
      await expect(dispatchRequest(base)).rejects.toBeDefined();
      expect(fetchCalls).toBe(2);
    });

    it('caps the dedupe registry to prevent unbounded growth on hung requests (M9)', async () => {
      const { __activeRequestsSize, createRegistry } = await import('../src/core/request');
      const registry = createRegistry();
      // Use a fetch that never settles so cleanup-on-settle never fires.
      global.fetch = vi.fn(() => new Promise(() => {})) as any;

      const before = __activeRequestsSize(registry);
      // 1500 > MAX_ACTIVE_REQUESTS (1024). Unique URLs ⇒ unique dedupe keys.
      for (let i = 0; i < 1500; i++) {
        // Fire-and-forget — the promises never settle.
        void dispatchRequest(
          {
            url: `https://api.test.com/hang/${i}`,
            method: 'get',
            headers: {},
            dedupe: true,
          } as any,
          registry,
        ).catch(() => {});
      }
      const after = __activeRequestsSize(registry);
      expect(after - before).toBeLessThanOrEqual(1024);
    });

    it('catches a malicious baseURL scheme', async () => {
      mockFetch({});
      await expect(
        dispatchRequest({
          baseURL: 'file://etc',
          url: 'passwd',
          method: 'get',
          headers: {},
        }),
      ).rejects.toMatchObject({ code: 'ERR_BAD_OPTION' });
    });
  });

  describe('schema validation (config.schema)', () => {
    it('successfully parses data using a synchronous validator', async () => {
      mockFetch({ id: 1, name: 'Alice' });

      const syncSchema = {
        parse: vi.fn((data: any) => ({ ...data, parsed: true })),
      };

      const response = await dispatchRequest({
        url: 'https://api.test.com/user',
        method: 'get',
        headers: {},
        schema: syncSchema,
      });

      expect(syncSchema.parse).toHaveBeenCalled();
      expect(response.data).toEqual({ id: 1, name: 'Alice', parsed: true });
    });

    it('successfully parses data using an asynchronous validator', async () => {
      mockFetch({ id: 2, name: 'Bob' });

      const asyncSchema = {
        parse: vi.fn((data: any) => data),
        parseAsync: vi.fn(async (data: any) => ({ ...data, parsedAsync: true })),
      };

      const response = await dispatchRequest({
        url: 'https://api.test.com/user',
        method: 'get',
        headers: {},
        schema: asyncSchema,
      });

      expect(asyncSchema.parseAsync).toHaveBeenCalled();
      expect(asyncSchema.parse).not.toHaveBeenCalled();
      expect(response.data).toEqual({ id: 2, name: 'Bob', parsedAsync: true });
    });

    it('throws CorriereError if schema parsing fails', async () => {
      mockFetch({ invalid: 'data' });

      const failingSchema = {
        parse: vi.fn(() => {
          throw new Error('Validation failed');
        }),
      };

      await expect(
        dispatchRequest({
          url: 'https://api.test.com/user',
          method: 'get',
          headers: {},
          schema: failingSchema,
        }),
      ).rejects.toMatchObject({
        isCorriereError: true,
        code: 'ERR_BAD_RESPONSE',
        message: expect.stringContaining('Validation failed'),
      });
    });
  });
});

describe('responseType: text override', () => {
  it('returns raw text even when content-type is application/json', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve('{"json": true}'),
    });
    global.fetch = mockFetch;

    const client = new Corriere();
    const response = await client.request({
      url: '/json-as-text',
      responseType: 'text',
    });
    expect(response.data).toBe('{"json": true}');
  });
});

describe('Abort reason propagation', () => {
  it('propagates the signal reason to CorriereError message and cause', async () => {
    const controller = new AbortController();
    const customError = new Error('Custom abort reason');

    const client = new Corriere();
    global.fetch = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        if (init.signal?.aborted) {
          reject(customError);
          return;
        }
        init.signal.addEventListener('abort', () => reject(customError));
      });
    });

    const p = client.request({
      url: '/abort-test',
      signal: controller.signal,
    });

    controller.abort(customError);

    await expect(p).rejects.toMatchObject({
      isCorriereError: true,
      code: 'ERR_CANCELED',
      message: 'Custom abort reason',
      cause: customError,
    });
  });
});

describe('fetchAdapter', () => {
  it('rejects upfront on a content-length over maxContentLength', async () => {
    const client = new Corriere();
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-length': '1000' }),
      text: () => Promise.resolve('hello'),
    });
    await expect(
      client.request({
        url: '/test',
        maxContentLength: 500,
      }),
    ).rejects.toThrow('maxContentLength size of 500 exceeded');
  });
});

describe('fetchAdapter', () => {
  it('runs abort cleanup immediately when a stream is cancelled directly', async () => {
    const client = new Corriere();
    const ctrl = new AbortController();
    let listenerRemoved = false;

    const originalRemoveEventListener = ctrl.signal.removeEventListener.bind(ctrl.signal);
    ctrl.signal.removeEventListener = (type: string, listener: any, options?: any) => {
      if (type === 'abort') {
        listenerRemoved = true;
      }
      return originalRemoveEventListener(type, listener, options);
    };

    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk'));
      },
    });

    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: mockStream,
    });

    const res = await client.request({
      url: '/stream-cancel-test',
      responseType: 'stream',
      signal: ctrl.signal,
      timeout: 5000,
    });

    expect(listenerRemoved).toBe(false);

    // Directly cancel the stream
    await res.data.cancel();

    expect(listenerRemoved).toBe(true);
  });
});

describe('maxContentLength chunked stream validation', () => {
  it('aborts chunked stream responses if size exceeds maxContentLength', async () => {
    const client = new Corriere();
    const encoder = new TextEncoder();

    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('12345'));
        controller.enqueue(encoder.encode('67890'));
        controller.enqueue(encoder.encode('exceeded_chunk'));
        controller.close();
      },
    });

    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers(), // No Content-Length header to simulate chunked transfer
      body: mockStream,
    });

    const p = client.request({
      url: '/chunked-limit',
      maxContentLength: 10,
      responseType: 'text',
    });

    await expect(p).rejects.toThrow('maxContentLength size of 10 exceeded');
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('schema validation runs after transformResponse', () => {
  beforeEach(() => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse({ count: '5' }))) as any;
  });

  it('validates the transformed value, not the raw adapter output', async () => {
    const seenBySchema: unknown[] = [];
    const res = await dispatchRequest({
      url: 'https://api.test.com/x',
      method: 'get',
      transformResponse: [(data: any) => ({ count: Number(data.count) })],
      schema: {
        parse: (data: unknown) => {
          seenBySchema.push(data);
          return data;
        },
      },
    });

    expect(seenBySchema).toEqual([{ count: 5 }]);
    expect(res.data).toEqual({ count: 5 });
  });

  it('reports a status failure rather than a schema failure on a bad status', async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse({ error: 'boom' }, 500))) as any;
    const schema = { parse: vi.fn(() => ({})) };

    await expect(
      dispatchRequest({
        url: 'https://api.test.com/x',
        method: 'get',
        validateStatus: (s: number) => s < 400,
        schema,
      }),
    ).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE', message: /status code 500/ });
    expect(schema.parse).not.toHaveBeenCalled();
  });

  it('surfaces a schema failure as ERR_BAD_RESPONSE', async () => {
    await expect(
      dispatchRequest({
        url: 'https://api.test.com/x',
        method: 'get',
        schema: {
          parse: () => {
            throw new Error('expected number, got string');
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'ERR_BAD_RESPONSE',
      message: 'expected number, got string',
    });
  });

  it('supports an async parseAsync schema', async () => {
    const res = await dispatchRequest({
      url: 'https://api.test.com/x',
      method: 'get',
      schema: {
        parse: () => ({ never: true }),
        parseAsync: async (data: any) => ({ parsed: data.count }),
      },
    });
    expect(res.data).toEqual({ parsed: '5' });
  });
});
