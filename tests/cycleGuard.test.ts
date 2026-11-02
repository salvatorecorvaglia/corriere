import { describe, expect, it } from 'vitest';
import { serializeParams } from '../src/core/buildURL';
import { toFormData } from '../src/helpers/toFormData';

describe('cycle guards track the current path, not every object seen', () => {
  it('skips direct and mutual array cycles while retaining scalar values', () => {
    const direct: unknown[] = [1];
    direct.push(direct, 2);
    expect(serializeParams({ values: direct })).toBe('values=1&values=2');
    const first: unknown[] = ['a'];
    const second: unknown[] = ['b', first];
    first.push(second);
    expect(serializeParams({ values: first })).toBe('values=a&values%5B1%5D=b');
  });

  it('breaks mixed object-array cycles and serializes shared arrays at each path', () => {
    const values: unknown[] = [];
    const nested = { id: 7, values };
    values.push(nested);
    expect(serializeParams({ a: values, b: values })).toBe('a%5B0%5D%5Bid%5D=7&b%5B0%5D%5Bid%5D=7');
    const shared = ['one', 'two'];
    expect(serializeParams({ a: shared, b: shared })).toBe('a=one&a=two&b=one&b=two');
  });

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
