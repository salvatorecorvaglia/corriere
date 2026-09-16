import { ERR_BAD_OPTION } from '../constants/errorCodes';
import CorriereError from '../core/corriereError';

const HEADER_FORBIDDEN_CHAR = /[\r\n\0]/;

function assertSafeHeader(name: string, value: string | string[]): void {
  if (typeof name !== 'string' || HEADER_FORBIDDEN_CHAR.test(name)) {
    throw new CorriereError(
      `Invalid header name "${String(name)}": CR, LF and NUL are not allowed`,
      ERR_BAD_OPTION,
      null,
      null,
      null,
    );
  }
  const values = Array.isArray(value) ? value : [value];
  for (const v of values) {
    if (typeof v === 'string' && HEADER_FORBIDDEN_CHAR.test(v)) {
      throw new CorriereError(
        `Invalid value for header "${name}": CR, LF and NUL are not allowed`,
        ERR_BAD_OPTION,
        null,
        null,
        null,
      );
    }
  }
}

const METHOD_KEYS = new Set<string>([
  'common',
  'delete',
  'get',
  'head',
  'options',
  'post',
  'put',
  'patch',
]);

type HeadersConfig = Record<string, Record<string, string | string[]>>;

export function flattenHeaders(
  headers: HeadersConfig | undefined,
  method?: string,
): Record<string, string | string[]> {
  if (!headers) return {};

  const merged: Record<string, string | string[]> = {};
  const lowerKeys: Record<string, string> = {};
  const methodLower = (method || 'get').toLowerCase();

  const setHeader = (target: Record<string, string | string[]>, key: string, value: any) => {
    const keyLower = key.toLowerCase();
    const existingKey = lowerKeys[keyLower];
    if (existingKey !== undefined) {
      delete target[existingKey];
    }
    target[key] = value;
    lowerKeys[keyLower] = key;
  };

  if (headers.common && typeof headers.common === 'object' && !Array.isArray(headers.common)) {
    for (const key in headers.common) {
      if (Object.hasOwn(headers.common, key)) {
        setHeader(merged, key, headers.common[key]);
      }
    }
  }

  if (
    headers[methodLower] &&
    typeof headers[methodLower] === 'object' &&
    !Array.isArray(headers[methodLower])
  ) {
    for (const key in headers[methodLower]) {
      if (Object.hasOwn(headers[methodLower], key)) {
        setHeader(merged, key, headers[methodLower][key]);
      }
    }
  }

  for (const key in headers) {
    if (Object.hasOwn(headers, key)) {
      const value = headers[key];
      const isMethodKey = METHOD_KEYS.has(key);
      const isObjectGroup =
        isMethodKey && value && typeof value === 'object' && !Array.isArray(value);
      if (!isObjectGroup) {
        setHeader(merged, key, value);
      }
    }
  }

  return merged;
}

export function removeContentType(headers: Record<string, string | string[]>): void {
  for (const key in headers) {
    if (Object.hasOwn(headers, key)) {
      if (key.toLowerCase() === 'content-type') {
        delete headers[key];
      }
    }
  }
}

export function buildFetchHeaders(headers: Record<string, string | string[]>): Headers {
  const fetchHeaders = new Headers();
  for (const key in headers) {
    if (Object.hasOwn(headers, key)) {
      const value = headers[key];
      if (value === undefined || value === null) continue;
      assertSafeHeader(key, value);
      if (Array.isArray(value)) {
        if (value.length === 0) {
          // Matches the empty-string scalar case below: an explicitly-set-but-empty header
          // still becomes a real (empty-valued) header rather than silently vanishing.
          fetchHeaders.set(key, '');
          continue;
        }
        for (let i = 0; i < value.length; i++) {
          const v = value[i];
          if (v !== undefined && v !== null) {
            fetchHeaders.append(key, v);
          }
        }
      } else {
        fetchHeaders.set(key, value);
      }
    }
  }
  return fetchHeaders;
}
