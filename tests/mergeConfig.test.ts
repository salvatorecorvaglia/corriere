import { describe, expect, it, vi } from 'vitest';
import mergeConfig, { deepMerge } from '../src/core/mergeConfig';
import Corriere from '../src/corriere';

describe('mergeConfig', () => {
  it('returns config2 values when both are provided', () => {
    const result = mergeConfig(
      { baseURL: 'https://old.com', timeout: 1000 },
      { baseURL: 'https://new.com', timeout: 5000 },
    );
    expect(result.baseURL).toBe('https://new.com');
    expect(result.timeout).toBe(5000);
  });

  it('falls back to config1 when config2 key is undefined', () => {
    const result = mergeConfig({ baseURL: 'https://api.com', timeout: 3000 }, {});
    expect(result.baseURL).toBe('https://api.com');
    expect(result.timeout).toBe(3000);
  });

  it('takes url, method, data only from config2', () => {
    const result = mergeConfig(
      { url: '/old', method: 'get', data: { old: true } },
      { url: '/new', method: 'post', data: { new: true } },
    );
    expect(result.url).toBe('/new');
    expect(result.method).toBe('post');
    expect(result.data).toEqual({ new: true });
  });

  it('ignores url/data from config1 if not in config2 but inherits method', () => {
    const result = mergeConfig({ url: '/old', method: 'get', data: { a: 1 } }, {});
    expect(result.url).toBeUndefined();
    expect(result.data).toBeUndefined();
    expect(result.method).toBe('get');
  });

  it('deep merges headers', () => {
    const result = mergeConfig(
      { headers: { common: { Accept: 'application/json' }, 'X-Default': 'yes' } as any },
      { headers: { common: { Authorization: 'Bearer tok' }, 'X-Custom': 'val' } as any },
    );
    expect((result.headers as any).common.Accept).toBe('application/json');
    expect((result.headers as any).common.Authorization).toBe('Bearer tok');
    expect((result.headers as any)['X-Default']).toBe('yes');
    expect((result.headers as any)['X-Custom']).toBe('val');
  });

  it('handles empty configs', () => {
    const result = mergeConfig({}, {});
    expect(result).toEqual({});
  });

  it('handles undefined configs', () => {
    const result = mergeConfig();
    expect(result).toEqual({});
  });

  it('does not let a __proto__ key in config1 or config2 change the prototype of the result', () => {
    const malicious1 = JSON.parse(
      '{"__proto__":{"allowedProtocols":null},"baseURL":"https://a.com"}',
    );
    const result1 = mergeConfig(malicious1, {});
    expect(Object.getPrototypeOf(result1)).toBe(Object.prototype);
    expect((result1 as any).allowedProtocols).toBeUndefined();

    const malicious2 = JSON.parse(
      '{"url":"file:///etc/passwd","__proto__":{"allowedProtocols":null}}',
    );
    const result2 = mergeConfig({ allowedProtocols: ['https:'] } as any, malicious2);
    expect(Object.getPrototypeOf(result2)).toBe(Object.prototype);
    expect((result2 as any).allowedProtocols).toEqual(['https:']);
  });

  it('does not let constructor/prototype keys pollute the result', () => {
    const malicious = JSON.parse('{"constructor":{"evil":true},"prototype":{"evil":true}}');
    const result = mergeConfig(malicious, {});
    expect((result as any).constructor).toBe(Object);
    expect((result as any).prototype).toBeUndefined();
  });
});

describe('deepMerge', () => {
  it('merges flat objects', () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it('overrides values from later sources', () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it('deeply merges nested objects', () => {
    const result = deepMerge({ nested: { a: 1 } }, { nested: { b: 2 } });
    expect(result).toEqual({ nested: { a: 1, b: 2 } });
  });

  it('replaces arrays instead of merging', () => {
    const result = deepMerge({ arr: [1, 2] }, { arr: [3, 4] });
    expect(result.arr).toEqual([3, 4]);
  });

  it('preserves Date instances by reference', () => {
    const date = new Date('2025-06-01');
    const result = deepMerge({}, { created: date });
    expect(result.created).toBe(date);
    expect(result.created instanceof Date).toBe(true);
  });

  it('preserves RegExp instances by reference', () => {
    const re = /test/gi;
    const result = deepMerge({}, { pattern: re });
    expect(result.pattern).toBe(re);
    expect(result.pattern instanceof RegExp).toBe(true);
  });

  it('preserves Map instances by reference', () => {
    const map = new Map([['key', 'value']]);
    const result = deepMerge({}, { data: map });
    expect(result.data).toBe(map);
  });

  it('preserves Set instances by reference', () => {
    const set = new Set([1, 2, 3]);
    const result = deepMerge({}, { items: set });
    expect(result.items).toBe(set);
  });

  it('skips undefined values', () => {
    const result = deepMerge({ a: 1 }, { a: undefined });
    expect(result.a).toBe(1);
  });

  it('ignores non-object sources', () => {
    const result = deepMerge({ a: 1 }, null, undefined, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });
});

describe('Merged configurations prototype methods availability', () => {
  it('ensures configuration objects returned support hasOwnProperty checks', () => {
    const config = mergeConfig(
      { baseURL: 'https://api.com', headers: { common: { 'X-Test': '1' } } },
      { timeout: 5000 },
    );

    expect(config.hasOwnProperty).toBeDefined();
    // biome-ignore lint/suspicious/noPrototypeBuiltins: testing direct hasOwnProperty access
    expect(config.hasOwnProperty('baseURL')).toBe(true);
    // biome-ignore lint/suspicious/noPrototypeBuiltins: testing direct hasOwnProperty access
    expect(config.hasOwnProperty('timeout')).toBe(true);
    // biome-ignore lint/suspicious/noPrototypeBuiltins: testing direct hasOwnProperty access
    expect(config.hasOwnProperty('headers')).toBe(true);
    // biome-ignore lint/suspicious/noPrototypeBuiltins: testing direct hasOwnProperty access
    expect(config.hasOwnProperty('nonexistent')).toBe(false);
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('instances do not share mutable default transforms', () => {
  it('mutating one instance transformRequest array leaves others untouched', () => {
    const a = new Corriere();
    const b = new Corriere();
    const before = (b.defaults.transformRequest as any[]).length;

    (a.defaults.transformRequest as any[]).push(() => 'injected');

    expect((b.defaults.transformRequest as any[]).length).toBe(before);
    expect(a.defaults.transformRequest).not.toBe(b.defaults.transformRequest);
  });

  it('an added transform still applies to the instance that added it', async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse({ ok: true }))) as any;
    const client = new Corriere({ baseURL: 'https://api.test.com' });
    (client.defaults.transformRequest as any[]).push(() => 'REPLACED');

    await client.post('/x', { original: true });
    const init = (global.fetch as any).mock.calls[0][1];
    expect(init.body).toBe('REPLACED');
  });
});
