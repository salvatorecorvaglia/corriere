import { describe, expect, it } from 'vitest';
import buildURL, { combineURLs, isAbsoluteURL, serializeParams } from '../src/core/buildURL';

describe('buildURL', () => {
  it('returns the url as-is when no baseURL or params', () => {
    expect(buildURL('/users')).toBe('/users');
  });

  it('combines baseURL and relative URL', () => {
    expect(buildURL('/users', 'https://api.example.com')).toBe('https://api.example.com/users');
  });

  it('removes duplicate slashes when combining', () => {
    expect(buildURL('/users/', 'https://api.example.com/')).toBe('https://api.example.com/users/');
  });

  it('does not prepend baseURL when url is absolute', () => {
    expect(buildURL('https://other.com/users', 'https://api.example.com')).toBe(
      'https://other.com/users',
    );
  });

  it('appends params as query string', () => {
    const result = buildURL('/users', undefined, { page: 1, limit: 10 });
    expect(result).toBe('/users?page=1&limit=10');
  });

  it('appends params to URL that already has query params', () => {
    const result = buildURL('/users?sort=name', undefined, { page: 1 });
    expect(result).toBe('/users?sort=name&page=1');
  });

  it('preserves the URL fragment when appending params (M2)', () => {
    expect(buildURL('/users#section', undefined, { page: 1 })).toBe('/users?page=1#section');
    expect(buildURL('/users?sort=name#top', undefined, { page: 1 })).toBe(
      '/users?sort=name&page=1#top',
    );
  });

  it('does not corrupt port numbers in absolute URLs', () => {
    const result = buildURL('http://localhost:3000/users', undefined, { '3000': 'val' });
    expect(result).toBe('http://localhost:3000/users?3000=val');
  });

  it('ignores prototype-polluting param keys in path templates (M6)', () => {
    const polluted = JSON.parse('{"__proto__":"evil","id":"42"}');
    expect(buildURL('/users/{id}/{__proto__}', undefined, polluted)).toBe('/users/42/{__proto__}');
    expect(buildURL('/users/:constructor', undefined, JSON.parse('{"constructor":"x"}'))).toBe(
      '/users/:constructor',
    );
  });

  it('does not treat a literal colon-suffixed path segment as a placeholder', () => {
    const result = buildURL('/v1/files/123:download', undefined, { download: 'true' });
    expect(result).toBe('/v1/files/123:download?download=true');
  });

  it('still substitutes genuine :name path placeholders', () => {
    const result = buildURL('/users/:id/posts/:postId', undefined, {
      id: '42',
      postId: '7',
      extra: 'x',
    });
    expect(result).toBe('/users/42/posts/7?extra=x');
  });

  it('uses custom paramsSerializer', () => {
    const serializer = (params: Record<string, unknown>) =>
      `custom=${Object.keys(params).join(',')}`;
    const result = buildURL('/users', undefined, { a: 1, b: 2 }, serializer);
    expect(result).toBe('/users?custom=a,b');
  });

  it('returns empty string when no url and no baseURL', () => {
    expect(buildURL('')).toBe('');
  });
});

describe('serializeParams', () => {
  it('returns empty string for null/undefined', () => {
    expect(serializeParams(null as any)).toBe('');
    expect(serializeParams(undefined as any)).toBe('');
  });

  it('serializes simple key-value pairs', () => {
    expect(serializeParams({ foo: 'bar', baz: 42 })).toBe('foo=bar&baz=42');
  });

  it('skips null and undefined values', () => {
    expect(serializeParams({ a: 1, b: null, c: undefined, d: 2 })).toBe('a=1&d=2');
  });

  it('serializes arrays', () => {
    const result = serializeParams({ tags: ['a', 'b'] });
    expect(result).toBe('tags=a&tags=b');
  });

  it('serializes nested objects', () => {
    const result = serializeParams({ filter: { status: 'active' } });
    expect(result).toBe('filter%5Bstatus%5D=active');
  });

  it('serializes Date to ISO string', () => {
    const date = new Date('2025-01-01T00:00:00.000Z');
    const result = serializeParams({ date });
    expect(result).toBe('date=2025-01-01T00%3A00%3A00.000Z');
  });
});

describe('combineURLs', () => {
  it('returns relativeURL when baseURL is empty', () => {
    expect(combineURLs('', '/users')).toBe('/users');
  });

  it('returns baseURL when relativeURL is empty', () => {
    expect(combineURLs('https://api.example.com', '')).toBe('https://api.example.com');
  });

  it('combines and normalizes slashes', () => {
    expect(combineURLs('https://api.example.com/', '/users')).toBe('https://api.example.com/users');
  });
});

describe('isAbsoluteURL', () => {
  it('detects http URLs', () => {
    expect(isAbsoluteURL('http://example.com')).toBe(true);
  });

  it('detects https URLs', () => {
    expect(isAbsoluteURL('https://example.com')).toBe(true);
  });

  it('detects protocol-relative URLs', () => {
    expect(isAbsoluteURL('//example.com')).toBe(false);
  });

  it('returns false for relative URLs', () => {
    expect(isAbsoluteURL('/users')).toBe(false);
    expect(isAbsoluteURL('users')).toBe(false);
  });
});

describe('serializeParams circular reference safety', () => {
  it('safely skips circular references in query params without throwing RangeError', async () => {
    const { serializeParams } = await import('../src/core/buildURL');
    const circular: any = { a: 1 };
    circular.self = circular;

    const result = serializeParams(circular);
    expect(result).toBe('a=1');
  });
});
