import { SENSITIVE_BODY_KEY } from '../core/corriereError';
import { isBinaryData, isReadableStream } from './isBinary';

/** A bounded preview that never invokes getters or user-supplied toJSON methods. */
export function debugPreview(value: unknown, maxLength = 200): string {
  let output = '';
  let truncated = false;
  let nodes = 0;
  const seen = new WeakSet<object>();
  function append(text: string): void {
    const available = maxLength - output.length;
    if (text.length > available) truncated = true;
    output += text.slice(0, available);
  }
  function quote(text: string): void {
    const prefix = text.slice(0, maxLength - output.length);
    if (prefix.length < text.length) truncated = true;
    append(JSON.stringify(prefix));
  }
  function visit(current: unknown, depth: number): void {
    if (output.length >= maxLength) {
      truncated = true;
      return;
    }
    if (++nodes > 100 || depth > 5) {
      quote('[Truncated]');
      truncated = true;
      return;
    }
    if (typeof current === 'string') {
      quote(current);
      return;
    }
    if (current === null || typeof current === 'boolean' || typeof current === 'number') {
      append(String(current));
      return;
    }
    if (typeof current !== 'object') {
      quote(`[${typeof current}]`);
      return;
    }
    if (isBinaryData(current) || isReadableStream(current)) {
      quote('[Binary/Stream Data]');
      return;
    }
    if (typeof FormData !== 'undefined' && current instanceof FormData) {
      quote('[FormData]');
      return;
    }
    if (seen.has(current)) {
      quote('[Circular]');
      return;
    }
    seen.add(current);
    const array = Array.isArray(current);
    append(array ? '[' : '{');
    let count = 0;
    for (const key in current) {
      if (!Object.hasOwn(current, key)) continue;
      if (output.length >= maxLength || nodes >= 100 || count >= 100) {
        truncated = true;
        break;
      }
      if (count++) append(',');
      if (!array) {
        quote(key);
        append(':');
      }
      if (SENSITIVE_BODY_KEY.test(key)) {
        quote('[REDACTED]');
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor && 'value' in descriptor) visit(descriptor.value, depth + 1);
      else quote('[Accessor]');
    }
    append(array ? ']' : '}');
    seen.delete(current);
  }
  try {
    visit(value, 0);
  } catch {
    return '[unserializable data]';
  }
  return output + (truncated ? '...' : '');
}
