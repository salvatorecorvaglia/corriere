import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/request', () => ({
  default: vi.fn((config: any) =>
    Promise.resolve({
      data: { ok: true },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
      request: {},
      duration: 10,
    }),
  ),
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

import corriere, {
  buildURL,
  Corriere,
  CorriereError,
  createInstance,
  createRateLimiter,
  InterceptorManager,
  mergeConfig,
} from '../src/index';

describe('index.ts — default instance and exports', () => {
  describe('default export (corriere)', () => {
    it('is a callable function', () => {
      expect(typeof corriere).toBe('function');
    });

    it('has all HTTP shorthand methods', () => {
      const methods = ['request', 'get', 'delete', 'head', 'options', 'post', 'put', 'patch'];
      for (const method of methods) {
        expect(typeof (corriere as any)[method]).toBe('function');
      }
    });

    it('has form methods', () => {
      for (const method of ['postForm', 'putForm', 'patchForm']) {
        expect(typeof (corriere as any)[method]).toBe('function');
      }
    });

    it('has getUri', () => {
      expect(typeof corriere.getUri).toBe('function');
    });

    it('has defaults property', () => {
      expect(corriere.defaults).toBeDefined();
      expect(corriere.defaults.method).toBe('get');
    });

    it('has interceptors', () => {
      expect(corriere.interceptors).toBeDefined();
      expect(corriere.interceptors.request).toBeDefined();
      expect(corriere.interceptors.response).toBeDefined();
    });

    it('corriere(config) delegates to request()', async () => {
      const res = await corriere({ url: 'https://test.com/api' });
      expect(res.status).toBe(200);
    });

    it('corriere(url, config) delegates to request()', async () => {
      const res = await corriere('https://test.com/api', { method: 'post' });
      expect(res.config.url).toBe('https://test.com/api');
    });
  });

  describe('corriere.create()', () => {
    it('creates a new callable instance', () => {
      const instance = corriere.create({ baseURL: 'https://api.test.com' });
      expect(typeof instance).toBe('function');
    });

    it('merges config with defaults', () => {
      const instance = corriere.create({
        baseURL: 'https://custom.com',
        timeout: 3000,
      });
      expect(instance.defaults.baseURL).toBe('https://custom.com');
      expect(instance.defaults.timeout).toBe(3000);
      expect(instance.defaults.responseType).toBe('json');
    });

    it('has all shorthand methods', () => {
      const instance = corriere.create({});
      for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
        expect(typeof (instance as any)[method]).toBe('function');
      }
    });

    it('has independent interceptors', () => {
      const instance = corriere.create({});
      expect(instance.interceptors).toBeDefined();
      expect(instance.interceptors.request).not.toBe(corriere.interceptors.request);
    });
  });

  describe('corriere.all()', () => {
    it('resolves all promises concurrently', async () => {
      const results = await corriere.all([
        Promise.resolve(1),
        Promise.resolve(2),
        Promise.resolve(3),
      ]);
      expect(results).toEqual([1, 2, 3]);
    });

    it('rejects if any promise rejects', async () => {
      await expect(
        corriere.all([Promise.resolve(1), Promise.reject(new Error('fail'))]),
      ).rejects.toThrow('fail');
    });
  });

  describe('corriere.spread()', () => {
    it('spreads array to arguments', () => {
      const fn = corriere.spread((a: number, b: number) => a + b);
      expect(fn([3, 7])).toBe(10);
    });
  });

  describe('corriere.isCancel()', () => {
    it('returns true for cancel errors', () => {
      const error = new CorriereError('cancelled', 'ERR_CANCELED', null, null, null);
      (error as any).isCorriereError = true;
      expect(corriere.isCancel(error)).toBe(true);
    });

    it('returns false for non-cancel errors', () => {
      const error = new CorriereError('network', 'ERR_NETWORK', null, null, null);
      expect(corriere.isCancel(error)).toBe(false);
    });

    it('returns false for non-CorriereError values', () => {
      expect(corriere.isCancel(null)).toBe(false);
      expect(corriere.isCancel(new Error('normal'))).toBe(false);
    });
  });

  describe('corriere.isCorriereError()', () => {
    it('returns true for CorriereError instances', () => {
      expect(corriere.isCorriereError(new CorriereError('test', '', null, null, null))).toBe(true);
    });

    it('returns true for duck-typed CorriereErrors', () => {
      expect(corriere.isCorriereError({ isCorriereError: true })).toBe(true);
    });

    it('returns false for regular errors', () => {
      expect(corriere.isCorriereError(new Error('test'))).toBe(false);
    });

    it('returns false for non-errors', () => {
      expect(corriere.isCorriereError(null)).toBe(false);
      expect(corriere.isCorriereError('string')).toBe(false);
    });
  });

  describe('exposed classes and utilities', () => {
    it('exposes CorriereError class', () => {
      expect(corriere.CorriereError).toBe(CorriereError);
    });

    it('exposes Corriere class', () => {
      expect(corriere.Corriere).toBe(Corriere);
    });

    it('exposes mergeConfig', () => {
      expect(corriere.mergeConfig).toBe(mergeConfig);
    });

    it('exposes buildURL', () => {
      expect(corriere.buildURL).toBe(buildURL);
    });

    it('exposes InterceptorManager', () => {
      expect(corriere.InterceptorManager).toBe(InterceptorManager);
    });

    it('exposes createRateLimiter', () => {
      expect(corriere.createRateLimiter).toBe(createRateLimiter);
    });
  });

  describe('named exports', () => {
    it('exports Corriere class', () => {
      expect(Corriere).toBeDefined();
      expect(typeof Corriere).toBe('function');
    });

    it('exports CorriereError class', () => {
      expect(CorriereError).toBeDefined();
      expect(typeof CorriereError).toBe('function');
    });

    it('exports mergeConfig function', () => {
      expect(typeof mergeConfig).toBe('function');
    });

    it('exports buildURL function', () => {
      expect(typeof buildURL).toBe('function');
    });

    it('exports InterceptorManager class', () => {
      expect(typeof InterceptorManager).toBe('function');
    });

    it('exports createInstance function', () => {
      expect(typeof createInstance).toBe('function');
    });

    it('exports createRateLimiter function', () => {
      expect(typeof createRateLimiter).toBe('function');
    });
  });
});
