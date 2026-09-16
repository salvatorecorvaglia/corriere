import { beforeEach, describe, expect, it, vi } from 'vitest';
import Corriere from '../src/corriere';

vi.mock('../src/core/request', () => ({
  default: vi.fn((config: any) => {
    return Promise.resolve({
      data: { ok: true },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
      request: {},
      duration: 42,
    });
  }),
  // `Corriere` also imports these from the same module, so a mock that provides only
  // `default` leaves the constructor calling `undefined`.
  createRegistry: () => ({ inflight: new Map(), cache: new Map() }),
  cacheKeyFor: (config: any) => `GET:${config.url}`,
}));

vi.mock('../src/core/retry', () => ({
  default: vi.fn((dispatchFn: any, config: any) => dispatchFn(config)),
}));

vi.mock('../src/helpers/debug', () => ({
  logRequest: vi.fn(),
  logResponse: vi.fn(),
  logError: vi.fn(),
}));

describe('Corriere class', () => {
  let corriere: InstanceType<typeof Corriere>;

  beforeEach(() => {
    corriere = new Corriere({
      baseURL: 'https://api.test.com',
      timeout: 5000,
    });
  });

  describe('constructor', () => {
    it('stores instance defaults', () => {
      expect(corriere.defaults.baseURL).toBe('https://api.test.com');
      expect(corriere.defaults.timeout).toBe(5000);
    });

    it('creates request and response interceptor managers', () => {
      expect(corriere.interceptors.request).toBeDefined();
      expect(corriere.interceptors.response).toBeDefined();
      expect(typeof corriere.interceptors.request.use).toBe('function');
      expect(typeof corriere.interceptors.response.use).toBe('function');
    });

    it('defaults to system defaults when none provided', () => {
      const c = new Corriere();
      expect(c.defaults).toMatchObject({ method: 'get', timeout: 0 });
    });
  });

  describe('request()', () => {
    it('accepts a config object', async () => {
      const res = await corriere.request({ url: '/users', method: 'get' });
      expect(res.status).toBe(200);
      expect(res.data).toEqual({ ok: true });
    });

    it('accepts (url, config) syntax', async () => {
      const res = await corriere.request('/users', { method: 'post' });
      expect(res.config.url).toBe('/users');
      expect(res.config.method).toBe('post');
    });

    it('defaults method to "get"', async () => {
      const res = await corriere.request({ url: '/test' });
      expect(res.config.method).toBe('get');
    });

    it('lowercases the method', async () => {
      const res = await corriere.request({ url: '/test', method: 'POST' });
      expect(res.config.method).toBe('post');
    });

    it('rejects with CorriereError when no url or baseURL is provided', async () => {
      const bare = new Corriere();
      // Must reject, not throw synchronously — otherwise `.catch()` cannot intercept it.
      expect(() => bare.request({}).catch(() => {})).not.toThrow();
      await expect(bare.request({})).rejects.toThrow('Request URL is required');
    });

    it('merges with instance defaults', async () => {
      const res = await corriere.request({ url: '/users' });
      expect(res.config.baseURL).toBe('https://api.test.com');
      expect(res.config.timeout).toBe(5000);
    });
  });

  describe('shorthand methods without body', () => {
    for (const method of ['get', 'delete', 'head', 'options']) {
      it(`${method}() sets correct method and url`, async () => {
        const res = await (corriere as any)[method]('/endpoint');
        expect(res.config.method).toBe(method);
        expect(res.config.url).toBe('/endpoint');
      });

      it(`${method}() merges extra config`, async () => {
        const res = await (corriere as any)[method]('/endpoint', { timeout: 9999 });
        expect(res.config.timeout).toBe(9999);
      });
    }
  });

  describe('shorthand methods with body', () => {
    for (const method of ['post', 'put', 'patch']) {
      it(`${method}() sets method, url, and data`, async () => {
        const body = { name: 'test' };
        const res = await (corriere as any)[method]('/endpoint', body);
        expect(res.config.method).toBe(method);
        expect(res.config.url).toBe('/endpoint');
        expect(res.config.data).toEqual(body);
      });

      it(`${method}() merges extra config`, async () => {
        const res = await (corriere as any)[method]('/endpoint', null, {
          timeout: 1234,
        });
        expect(res.config.timeout).toBe(1234);
      });
    }
  });

  describe('form methods', () => {
    for (const method of ['post', 'put', 'patch']) {
      const formMethod = `${method}Form`;

      it(`${formMethod}() sets Content-Type to multipart/form-data`, async () => {
        const res = await (corriere as any)[formMethod]('/upload', {
          file: 'data',
        });
        expect(res.config.headers).toBeDefined();
        expect(res.config.headers!['Content-Type']).toBe('multipart/form-data');
      });

      it(`${formMethod}() sets correct method`, async () => {
        const res = await (corriere as any)[formMethod]('/upload', null);
        expect(res.config.method).toBe(method);
      });
    }
  });

  describe('getUri()', () => {
    it('builds URL from config and defaults', () => {
      const uri = corriere.getUri({ url: '/users', params: { page: 1 } });
      expect(uri).toBe('https://api.test.com/users?page=1');
    });

    it('works without params', () => {
      const uri = corriere.getUri({ url: '/users' });
      expect(uri).toBe('https://api.test.com/users');
    });
  });

  describe('interceptors', () => {
    it('request interceptors modify config', async () => {
      corriere.interceptors.request.use((config: any) => {
        config.headers = config.headers || {};
        config.headers['X-Test'] = 'intercepted';
        return config;
      });

      const res = await corriere.request({ url: '/test' });
      expect(res.config.headers!['X-Test']).toBe('intercepted');
    });

    it('response interceptors modify response', async () => {
      corriere.interceptors.response.use((response: any) => {
        response.data = { ...response.data, intercepted: true };
        return response;
      });

      const res = await corriere.request({ url: '/test' });
      expect(res.data.intercepted).toBe(true);
    });

    it('request interceptors with runWhen condition', async () => {
      let called = false;
      corriere.interceptors.request.use(
        (config: any) => {
          called = true;
          return config;
        },
        undefined,
        { runWhen: (config: any) => config.method === 'post' },
      );

      await corriere.get('/test');
      expect(called).toBe(false);
    });

    it('request interceptors run in reverse order', async () => {
      const order: string[] = [];
      corriere.interceptors.request.use((config: any) => {
        order.push('first');
        return config;
      });
      corriere.interceptors.request.use((config: any) => {
        order.push('second');
        return config;
      });

      await corriere.request({ url: '/test' });
      expect(order).toEqual(['second', 'first']);
    });

    it('response interceptors run in normal order', async () => {
      const order: string[] = [];
      corriere.interceptors.response.use((response: any) => {
        order.push('first');
        return response;
      });
      corriere.interceptors.response.use((response: any) => {
        order.push('second');
        return response;
      });

      await corriere.request({ url: '/test' });
      expect(order).toEqual(['first', 'second']);
    });

    it('ejected interceptors are skipped', async () => {
      let called = false;
      const id = corriere.interceptors.request.use((config: any) => {
        called = true;
        return config;
      });
      corriere.interceptors.request.eject(id);

      await corriere.request({ url: '/test' });
      expect(called).toBe(false);
    });

    it('response interceptor rejection path and recovery', async () => {
      const mockError = new Error('Network Failure');
      const reqMock = (await import('../src/core/request')).default as any;
      reqMock.mockRejectedValueOnce(mockError);

      corriere.interceptors.response.use(
        (res: any) => res,
        (err: any) => {
          return { data: { recovered: true, originalError: err.message }, status: 200 };
        },
      );

      const res = await corriere.request({ url: '/test-error' });
      expect(res.data.recovered).toBe(true);
      expect(res.data.originalError).toBe('Network Failure');
    });

    it('response interceptor rejection propagates if not caught', async () => {
      const mockError = new Error('Critical Network Failure');
      const reqMock = (await import('../src/core/request')).default as any;
      reqMock.mockRejectedValueOnce(mockError);

      corriere.interceptors.response.use(
        (res: any) => res,
        (err: any) => {
          throw new Error(`Wrapped: ${err.message}`);
        },
      );

      await expect(corriere.request({ url: '/test-error' })).rejects.toThrow(
        'Wrapped: Critical Network Failure',
      );
    });
  });
});
