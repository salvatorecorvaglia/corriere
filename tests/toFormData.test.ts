import { describe, expect, it, vi } from 'vitest';
import Corriere from '../src/corriere';
import { toFormData } from '../src/helpers/toFormData';

describe('toFormData', () => {
  it('appends primitive values', () => {
    const fd = toFormData({ name: 'Alice', age: 30 });
    expect(fd.get('name')).toBe('Alice');
    expect(fd.get('age')).toBe('30');
  });

  it('serializes Date values to ISO strings', () => {
    const fd = toFormData({ created: new Date('2025-01-01T00:00:00.000Z') });
    expect(fd.get('created')).toBe('2025-01-01T00:00:00.000Z');
  });

  it('serializes nested objects with dot notation by default', () => {
    const fd = toFormData({ user: { name: 'Bob' } });
    expect(fd.get('user.name')).toBe('Bob');
  });

  it('serializes Set values instead of silently dropping the field', () => {
    const fd = toFormData({ tags: new Set(['a', 'b']) });
    expect(fd.get('tags[0]')).toBe('a');
    expect(fd.get('tags[1]')).toBe('b');
  });

  it('serializes Map values instead of silently dropping the field', () => {
    const fd = toFormData({ meta: new Map([['k', 'v']]) });
    expect(fd.get('meta.k')).toBe('v');
  });

  it('serializes a Map with bracket notation when options.brackets is set', () => {
    const fd = toFormData({ meta: new Map([['k', 'v']]) }, undefined, undefined, undefined, {
      brackets: true,
    });
    expect(fd.get('meta[k]')).toBe('v');
  });

  it('does not hang on a self-referencing Set', () => {
    const set: Set<unknown> = new Set();
    set.add(set);
    expect(() => toFormData({ tags: set })).not.toThrow();
  });

  it('does not hang on a self-referencing Map', () => {
    const map: Map<string, unknown> = new Map();
    map.set('self', map);
    expect(() => toFormData({ meta: map })).not.toThrow();
  });
});

describe('toFormData safety in environments without File or Blob', () => {
  it('serializes data without throwing ReferenceError', () => {
    // Save global references
    const originalFile = (global as any).File;
    const originalBlob = (global as any).Blob;

    try {
      // Delete global references to simulate environment without them
      (global as any).File = undefined;
      (global as any).Blob = undefined;

      const data = {
        name: 'test',
        nested: {
          value: 42,
        },
      };

      // Custom mock FormData because browser FormData might not exist or might behave differently in Node
      class MockFormData {
        data: Record<string, any> = {};
        append(key: string, val: any) {
          this.data[key] = val;
        }
      }
      const mockForm = new MockFormData() as any;

      const result = toFormData(data, mockForm);
      expect(result).toBeDefined();
      expect((result as any).data).toEqual({
        name: 'test',
        'nested.value': 42,
      });
    } finally {
      // Restore global references
      if (originalFile !== undefined) (global as any).File = originalFile;
      if (originalBlob !== undefined) (global as any).Blob = originalBlob;
    }
  });
});

describe('toFormData binary data handling', () => {
  it('appends buffers and typed arrays without recursion stack overflow', () => {
    const data = {
      name: 'test',
      buffer: typeof Buffer !== 'undefined' ? Buffer.from('hello') : new Uint8Array([1, 2, 3]),
      typedArray: new Uint8Array([4, 5, 6]),
    };

    class MockFormData {
      data: Record<string, any> = {};
      append(key: string, val: any) {
        this.data[key] = val;
      }
    }
    const mockForm = new MockFormData() as any;

    const result = toFormData(data, mockForm);
    expect(result).toBeDefined();
    expect((result as any).data.name).toBe('test');
    expect((result as any).data['nested.buffer']).toBeUndefined();
  });
});

describe('formSerializer brackets option support', () => {
  it('serializes nested objects using dot notation by default', async () => {
    const client = new Corriere();
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve('{}'),
    });
    global.fetch = mockFetch;

    // Custom mock FormData to extract keys
    const appendedKeys: Record<string, any> = {};
    class MockFormData {
      append(key: string, val: any) {
        appendedKeys[key] = val;
      }
    }
    const originalFormData = (global as any).FormData;
    (global as any).FormData = MockFormData;

    try {
      await client.postForm('/submit', { user: { id: 1, profile: { name: 'Bob' } } });
      expect(appendedKeys).toEqual({
        'user.id': 1,
        'user.profile.name': 'Bob',
      });
    } finally {
      (global as any).FormData = originalFormData;
    }
  });

  it('serializes nested objects using bracket notation when formSerializer.brackets is true', async () => {
    const client = new Corriere();
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      text: () => Promise.resolve('{}'),
    });
    global.fetch = mockFetch;

    const appendedKeys: Record<string, any> = {};
    class MockFormData {
      append(key: string, val: any) {
        appendedKeys[key] = val;
      }
    }
    const originalFormData = (global as any).FormData;
    (global as any).FormData = MockFormData;

    try {
      await client.postForm(
        '/submit',
        { user: { id: 1, profile: { name: 'Bob' } } },
        {
          formSerializer: { brackets: true },
        },
      );
      expect(appendedKeys).toEqual({
        'user[id]': 1,
        'user[profile][name]': 'Bob',
      });
    } finally {
      (global as any).FormData = originalFormData;
    }
  });
});

describe('toFormData circular reference handling', () => {
  it('does not throw stack overflow on circular structures', () => {
    const obj: any = { name: 'parent' };
    obj.self = obj;

    const result = toFormData(obj);
    expect(result).toBeDefined();
    expect(result.append).toBeDefined();
  });
});
