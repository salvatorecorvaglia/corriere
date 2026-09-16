import { describe, expect, it } from 'vitest';
import { serializeParams } from '../src/core/buildURL';
import { toFormData } from '../src/helpers/toFormData';

describe('cycle guards track the current path, not every object seen', () => {
  it('serializes the same object referenced under two param keys', () => {
    const shared = { id: 1 };
    const out = serializeParams({ a: shared, b: shared });
    expect(out).toContain('a%5Bid%5D=1');
    expect(out).toContain('b%5Bid%5D=1');
  });

  it('still breaks a genuine param cycle', () => {
    const cyclic: any = { name: 'x' };
    cyclic.self = cyclic;
    expect(() => serializeParams(cyclic)).not.toThrow();
    expect(serializeParams(cyclic)).toContain('name=x');
  });

  it('appends the same object referenced under two form keys', () => {
    const shared = { id: 7 };
    const fd = toFormData({ a: shared, b: shared });
    expect(fd.get('a.id')).toBe('7');
    expect(fd.get('b.id')).toBe('7');
  });

  it('still breaks a genuine form cycle', () => {
    const cyclic: any = { name: 'x' };
    cyclic.self = cyclic;
    expect(() => toFormData(cyclic)).not.toThrow();
    expect(toFormData(cyclic).get('name')).toBe('x');
  });
});
