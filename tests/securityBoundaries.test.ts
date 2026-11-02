import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { cacheKeyFor } from '../src/core/request';
import corriere, { CorriereError } from '../src/index';

describe('security boundaries', () => {
  it('hides raw request and response configs from Node inspection, including causes', () => {
    const config = { headers: { Authorization: 'Bearer inspection-secret' } };
    const response = {
      config,
      data: null,
      headers: {},
      status: 401,
      statusText: '',
      request: new Response(null),
      duration: 0,
    };
    const original = new CorriereError('Unauthorized', 'ERR_BAD_REQUEST', config, null, response);
    const wrapped = CorriereError.from(original, original.code!, config, null, response);
    expect(inspect(wrapped, { depth: null, showHidden: true })).not.toContain('inspection-secret');
    expect(wrapped.config?.headers?.Authorization).toBe('[REDACTED]');
    expect(wrapped.response?.status).toBe(401);
    expect(wrapped.cause).toBe(original);
  });

  it.each(['cache', 'dedupe'] as const)(
    'separates ambiguous header values for %s',
    async (feature) => {
      const fetch = vi.fn(
        async (_url: unknown, init?: RequestInit) =>
          new Response(JSON.stringify(Object.fromEntries(new Headers(init?.headers))), {
            headers: { 'content-type': 'application/json' },
          }),
      );
      const client = corriere.create({ [feature]: true, fetch });
      const firstRequest = client.get('https://example.test', { headers: { x: 'a&y=b' } });
      if (feature === 'cache') await firstRequest;
      const secondRequest = client.get('https://example.test', { headers: { x: 'a', y: 'b' } });
      const [first, second] = await Promise.all([firstRequest, secondRequest]);
      expect(first.data.x).toBe('a&y=b');
      expect(second.data).toMatchObject({ x: 'a', y: 'b' });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('canonicalizes header casing, order, and wire whitespace', () => {
    const url = 'https://example.test';
    expect(cacheKeyFor({ url, headers: { Z: 'last', A: ' first ' } })).toBe(
      cacheKeyFor({ url, headers: { a: 'first', z: 'last' } }),
    );
  });

  it.each(['../admin', '%2e%2e/admin', 'users/../../admin', '{id}/admin'])(
    'rejects final base-path escapes: %s',
    async (url) => {
      const fetch = vi.fn();
      const client = corriere.create({ baseURL: 'https://example.test/v1', fetch });
      const config = { params: { id: '..' } };
      await expect(client.get(url, config)).rejects.toMatchObject({ code: 'ERR_BAD_OPTION' });
      expect(() => client.getUri({ url, ...config })).toThrow(/outside baseURL/);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('enforces relative browser base paths and permits traversal within the boundary', () => {
    const client = corriere.create({ baseURL: '/api/v1' });
    expect(() => client.getUri({ url: '../admin' })).toThrow(/outside baseURL/);
    expect(client.getUri({ url: 'users/../items' })).toBe('/api/v1/users/../items');
  });

  it('preserves the explicit opt-out', () => {
    const client = corriere.create({ baseURL: 'https://example.test/v1', allowAbsoluteUrls: true });
    expect(client.getUri({ url: '../admin' })).toBe('https://example.test/v1/../admin');
  });

  it('redacts sensitive URLs in boundary error messages and serialization', async () => {
    const client = corriere.create({ baseURL: 'https://example.test/v1?token=base-secret' });
    const error = await client.get('https://other.test?token=url-secret').catch((e) => e);
    expect(error.code).toBe('ERR_BAD_OPTION');
    for (const secret of ['base-secret', 'url-secret']) {
      expect(inspect(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});
