/** Conservative payload estimate, not a measurement of the JavaScript engine's heap. */
export function estimateValueBytes(value: unknown, maxBytes: number): number {
  const seen = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;
  function visit(current: unknown, depth: number): void {
    if (bytes > maxBytes) return;
    if (++nodes > 10_000 || depth > 64) {
      bytes = Infinity;
      return;
    }
    if (current == null) {
      bytes += 8;
      return;
    }
    if (typeof current === 'string') {
      bytes += current.length * 2;
      return;
    }
    if (typeof current === 'number' || typeof current === 'bigint') {
      bytes += 8;
      return;
    }
    if (typeof current === 'boolean') {
      bytes += 4;
      return;
    }
    if (typeof current !== 'object') {
      bytes = Infinity;
      return;
    }
    if (seen.has(current)) return;
    seen.add(current);
    bytes += 32;
    if (
      current instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== 'undefined' && current instanceof SharedArrayBuffer)
    ) {
      bytes += current.byteLength;
      return;
    }
    if (ArrayBuffer.isView(current)) {
      visit(current.buffer, depth + 1);
      return;
    }
    if (typeof Blob !== 'undefined' && current instanceof Blob) {
      bytes += current.size;
      return;
    }
    if (current instanceof Date) {
      bytes += 8;
      return;
    }
    if (current instanceof RegExp) {
      bytes += current.source.length * 2;
      return;
    }
    if (current instanceof Map) {
      for (const [key, entry] of current) {
        bytes += 16;
        visit(key, depth + 1);
        visit(entry, depth + 1);
        if (bytes > maxBytes) break;
      }
      return;
    }
    if (current instanceof Set) {
      for (const entry of current) {
        bytes += 8;
        visit(entry, depth + 1);
        if (bytes > maxBytes) break;
      }
      return;
    }
    // Cache response budgets cover payload and metadata, not opaque transport handles.
    const responseEntry =
      depth === 0 &&
      Object.hasOwn(current, 'data') &&
      Object.hasOwn(current, 'headers') &&
      Object.hasOwn(current, 'request') &&
      typeof Object.getOwnPropertyDescriptor(current, 'status')?.value === 'number';
    for (const key in current) {
      if (!Object.hasOwn(current, key)) continue;
      bytes += key.length * 2 + 8;
      if (responseEntry && key === 'request') {
        bytes += 32;
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !('value' in descriptor)) {
        bytes = Infinity;
        break;
      }
      visit(descriptor.value, depth + 1);
      if (bytes > maxBytes) break;
    }
  }
  try {
    visit(value, 0);
  } catch {
    return Infinity;
  }
  return bytes;
}
