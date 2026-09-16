import { describe, expect, it } from 'vitest';
import CorriereError from '../src/core/corriereError';
import transformData from '../src/helpers/transformData';

describe('transformData', () => {
  it('returns data unchanged when no transforms', async () => {
    expect(await transformData(null as any, 'hello', {})).toBe('hello');
    expect(await transformData(undefined, 'hello', {})).toBe('hello');
    expect(await transformData([], 'hello', {})).toBe('hello');
  });

  it('applies a single transform', async () => {
    const transforms = [(data: any) => data.toUpperCase()];
    expect(await transformData(transforms, 'hello', {})).toBe('HELLO');
  });

  it('applies transforms in order (pipeline)', async () => {
    const transforms = [(data: any) => `${data} world`, (data: any) => data.toUpperCase()];
    expect(await transformData(transforms, 'hello', {})).toBe('HELLO WORLD');
  });

  it('passes headers to transform functions', async () => {
    const headers = { 'content-type': 'application/json' };
    const transforms = [(data: any, h: any) => ({ data, type: h['content-type'] })];
    const result = await transformData(transforms, 'test', headers);
    expect(result).toEqual({ data: 'test', type: 'application/json' });
  });

  it('skips non-function entries', async () => {
    const transforms = ['not a function' as any, (data: string) => `${data}!`, null as any];
    expect(await transformData(transforms, 'hello', {})).toBe('hello!');
  });

  it('handles non-array transforms gracefully', async () => {
    expect(await transformData('not an array' as any, 'data', {})).toBe('data');
  });

  it('wraps failures as ERR_BAD_REQUEST for request transforms by default', async () => {
    const throwing = [
      () => {
        throw new Error('nope');
      },
    ];
    await expect(transformData(throwing, 'data', {})).rejects.toMatchObject({
      isCorriereError: true,
      code: CorriereError.ERR_BAD_REQUEST,
    });
  });

  it('wraps failures as ERR_BAD_RESPONSE when direction is "response"', async () => {
    const throwing = [
      () => {
        throw new Error('parse fail');
      },
    ];
    await expect(transformData(throwing, 'data', {}, undefined, 'response')).rejects.toMatchObject({
      isCorriereError: true,
      code: CorriereError.ERR_BAD_RESPONSE,
    });
  });
});

import { defaultTransformRequest, defaultTransformResponse } from '../src/defaults/transforms';

describe('defaultTransformRequest', () => {
  it('returns null or undefined as is', () => {
    expect(defaultTransformRequest(null, {})).toBeNull();
    expect(defaultTransformRequest(undefined, {})).toBeUndefined();
  });

  it('returns string, ArrayBuffer, Blob, FormData, URLSearchParams, ReadableStream as is', () => {
    const stringData = 'hello';
    const buf = new ArrayBuffer(8);
    expect(defaultTransformRequest(stringData, {})).toBe(stringData);
    expect(defaultTransformRequest(buf, {})).toBe(buf);

    if (typeof Blob !== 'undefined') {
      const blob = new Blob();
      expect(defaultTransformRequest(blob, {})).toBe(blob);
    }
    if (typeof FormData !== 'undefined') {
      const fd = new FormData();
      expect(defaultTransformRequest(fd, {})).toBe(fd);
    }
    if (typeof URLSearchParams !== 'undefined') {
      const usp = new URLSearchParams();
      expect(defaultTransformRequest(usp, {})).toBe(usp);
    }
    if (typeof ReadableStream !== 'undefined') {
      const rs = new ReadableStream();
      expect(defaultTransformRequest(rs, {})).toBe(rs);
    }
  });

  it('serializes objects to JSON and defaults Content-Type header', () => {
    const headers: Record<string, string> = {};
    const obj = { x: 1 };
    const result = defaultTransformRequest(obj, headers);
    expect(result).toBe('{"x":1}');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('does not overwrite existing Content-Type header', () => {
    const headers: Record<string, string | string[]> = {
      'content-type': 'application/x-www-form-urlencoded',
    };
    const obj = { x: 1 };
    const result = defaultTransformRequest(obj, headers);
    expect(result).toBe('{"x":1}');
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('throws on circular references', () => {
    const obj: any = {};
    obj.self = obj;
    expect(() => defaultTransformRequest(obj, {})).toThrow('Cannot stringify circular structure');
  });
});

describe('defaultTransformResponse', () => {
  it('parses valid JSON string', () => {
    expect(defaultTransformResponse('{"ok":true}')).toEqual({ ok: true });
  });

  it('returns invalid JSON string as is', () => {
    expect(defaultTransformResponse('not json')).toBe('not json');
  });

  it('returns non-string values as is', () => {
    const obj = { ok: true };
    expect(defaultTransformResponse(obj)).toBe(obj);
  });
});

describe('transformData', () => {
  it('supports a single function instead of an array', async () => {
    const fn = (data: any) => `${data}!`;
    const result = await transformData(fn, 'hello', {});
    expect(result).toBe('hello!');
  });
});
