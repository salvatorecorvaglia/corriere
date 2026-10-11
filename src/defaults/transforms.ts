import { isBinaryData, isReadableStream } from '../helpers/isBinary';

/**
 * Replaces the content type when it is absent or JSON — the `post`/`put`/`patch` default —
 * with `contentType`, or just removes it when `contentType` is `null` (so fetch can derive
 * one, as it does from a `Blob`'s own type). A non-JSON type the caller set is kept.
 */
function relabelDefaultJSON(
  headers: Record<string, string | string[]>,
  contentType: string | null,
): void {
  if (!headers || typeof headers !== 'object') return;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
  const current = key ? String(headers[key]).toLowerCase() : '';
  if (key && !current.startsWith('application/json')) return;
  if (key) delete headers[key];
  if (contentType) headers['Content-Type'] = contentType;
}

export function defaultTransformRequest(
  data: unknown,
  headers: Record<string, string | string[]>,
): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  // Bodies fetch sends as they are. Each still needs an honest label: fetch derives one
  // only when no content type is set, and `post`/`put`/`patch` default to JSON.
  if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) {
    relabelDefaultJSON(headers, 'application/x-www-form-urlencoded;charset=utf-8');
    return data;
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    relabelDefaultJSON(headers, null);
    return data;
  }
  // Typed arrays and `Buffer` used to fall through to `JSON.stringify` below, which turned
  // raw bytes into `{"0":1,…}`.
  if (isBinaryData(data)) {
    relabelDefaultJSON(headers, 'application/octet-stream');
    return data;
  }

  if (
    typeof data === 'string' ||
    (typeof FormData !== 'undefined' && data instanceof FormData) ||
    isReadableStream(data)
  ) {
    return data;
  }

  if (typeof data === 'object') {
    if (headers && typeof headers === 'object') {
      const hasContentType = Object.keys(headers).some(
        (key) => key.toLowerCase() === 'content-type',
      );
      if (!hasContentType) {
        headers['Content-Type'] = 'application/json';
      }
    }
    try {
      return JSON.stringify(data);
    } catch (e: any) {
      if (e instanceof TypeError && e.message.toLowerCase().includes('circular')) {
        throw new Error('Corriere: Cannot stringify circular structure in request data');
      }
      throw e;
    }
  }

  return data;
}

/**
 * Only reached when the response's `content-type` was not `application/json` — the adapter
 * (`fetchAdapter.ts`'s `readResponseData`) already parses `application/json` bodies itself
 * and throws `ERR_BAD_RESPONSE` there if that parse fails. A malformed body on a
 * non-JSON-labeled response is therefore intentionally passed through as text here rather
 * than raising an error: a hard failure would be surprising for content the server never
 * claimed was JSON in the first place.
 */
export function defaultTransformResponse(data: unknown, _headers?: any, config?: any): unknown {
  if (config && config.responseType === 'text') {
    return data;
  }
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      // Not JSON — return as-is
    }
  }
  return data;
}
