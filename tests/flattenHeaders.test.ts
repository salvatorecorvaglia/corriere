import { describe, expect, it } from 'vitest';
import {
  buildFetchHeaders,
  flattenHeaders,
  removeContentType,
} from '../src/helpers/flattenHeaders';

describe('flattenHeaders', () => {
  it('merges common and method-specific groups, method taking precedence', () => {
    const result = flattenHeaders(
      {
        common: { Accept: 'application/json', 'X-Common': 'yes' },
        post: { Accept: 'text/plain' },
      },
      'post',
    );
    expect(result.Accept).toBe('text/plain');
    expect(result['X-Common']).toBe('yes');
  });

  it('overwrites case-variant keys without duplication', () => {
    const result = flattenHeaders(
      { common: { 'Content-Type': 'application/json' }, get: { 'content-type': 'text/html' } },
      'get',
    );
    expect(Object.keys(result)).toHaveLength(1);
    expect(result['content-type']).toBe('text/html');
  });

  it('passes through top-level headers that are not method groups', () => {
    const result = flattenHeaders({ 'X-Custom': 'val' } as any, 'get');
    expect(result['X-Custom']).toBe('val');
  });

  it('returns an empty object when headers is undefined', () => {
    expect(flattenHeaders(undefined)).toEqual({});
  });
});

describe('removeContentType', () => {
  it('removes Content-Type regardless of casing', () => {
    const headers = { 'Content-Type': 'application/json', Accept: 'text/plain' };
    removeContentType(headers);
    expect(headers['Content-Type']).toBeUndefined();
    expect(headers.Accept).toBe('text/plain');
  });
});

describe('buildFetchHeaders', () => {
  it('sets scalar header values', () => {
    const result = buildFetchHeaders({ Accept: 'application/json' });
    expect(result.get('Accept')).toBe('application/json');
  });

  it('appends each value for an array header', () => {
    const result = buildFetchHeaders({ 'X-Tag': ['a', 'b'] });
    expect(result.get('X-Tag')).toBe('a, b');
  });

  it('sets an empty header for an empty-string value', () => {
    const result = buildFetchHeaders({ 'X-Empty': '' });
    expect(result.has('X-Empty')).toBe(true);
    expect(result.get('X-Empty')).toBe('');
  });

  it('sets an empty header for an empty array value, matching the empty-string case', () => {
    const result = buildFetchHeaders({ 'X-Empty': [] });
    expect(result.has('X-Empty')).toBe(true);
    expect(result.get('X-Empty')).toBe('');
  });

  it('rejects header names containing CR/LF', () => {
    expect(() => buildFetchHeaders({ 'X-Bad\r\nInjected': 'x' })).toThrow();
  });

  it('rejects header values containing CR/LF', () => {
    expect(() => buildFetchHeaders({ 'X-Bad': 'value\r\nInjected: 1' })).toThrow();
  });
});

describe('flattenHeaders case-insensitive merging', () => {
  it('overwrites case-variant keys without duplication', async () => {
    const { flattenHeaders } = await import('../src/helpers/flattenHeaders');
    const headers = {
      common: {
        'Content-Type': 'application/json',
      },
      get: {
        'content-type': 'text/html',
      },
    };
    const result = flattenHeaders(headers, 'get');
    expect(Object.keys(result)).toHaveLength(1);
    expect(result['content-type']).toBe('text/html');
  });
});

describe('flattenHeaders', () => {
  it('handles primitive flat headers that collide with METHOD_KEYS or common', () => {
    const input = {
      common: 'flat-common-header',
      get: 'flat-get-header',
      'content-type': 'application/json',
    };
    const flat = flattenHeaders(input as any, 'get');
    expect(flat).toEqual({
      common: 'flat-common-header',
      get: 'flat-get-header',
      'content-type': 'application/json',
    });
  });
});
