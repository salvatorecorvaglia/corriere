import { describe, expect, it, vi } from 'vitest';
import corriere from '../src/index';

describe('request interceptor predicates', () => {
  it.each([false, true])(
    'rejects through .catch() when runWhen throws (synchronous: %s)',
    async (synchronous) => {
      const fetch = vi.fn();
      const handler = vi.fn((config) => config);
      const failure = new Error('predicate failed');
      const client = corriere.create({ fetch });
      client.interceptors.request.use(handler, null, {
        synchronous,
        runWhen() {
          throw failure;
        },
      });
      const caught = vi.fn();
      const request = client.get('https://example.test').catch(caught);
      await request;
      expect(caught).toHaveBeenCalledWith(failure);
      expect(handler).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('lets response interceptors observe and recover a predicate failure in order', async () => {
    const failure = new Error('predicate failed');
    const client = corriere.create({ fetch: vi.fn() });
    client.interceptors.request.use((config) => config, null, {
      runWhen() {
        throw failure;
      },
    });
    const seen: unknown[] = [];
    client.interceptors.response.use(null, (error) => {
      seen.push(error);
      return 'recovered';
    });
    client.interceptors.response.use((value) => {
      seen.push(value);
      return value;
    });
    expect(await client.get('https://example.test')).toBe('recovered');
    expect(seen).toEqual([failure, 'recovered']);
  });
});
