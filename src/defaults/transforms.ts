export function defaultTransformRequest(
  data: unknown,
  headers: Record<string, string | string[]>,
): unknown {
  if (data === null || data === undefined) {
    return data;
  }

  if (
    typeof data === 'string' ||
    data instanceof ArrayBuffer ||
    (typeof Blob !== 'undefined' && data instanceof Blob) ||
    (typeof FormData !== 'undefined' && data instanceof FormData) ||
    (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) ||
    (typeof ReadableStream !== 'undefined' && data instanceof ReadableStream)
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
