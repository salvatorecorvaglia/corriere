import { withCycleGuard } from '../helpers/cycleGuard';
import type { ParamsSerializer } from '../types';

function serializeParams(
  params: Record<string, unknown>,
  paramsSerializer?: ParamsSerializer,
): string {
  if (!params) return '';

  if (typeof paramsSerializer === 'function') {
    return paramsSerializer(params);
  }

  if (typeof URLSearchParams !== 'undefined' && params instanceof URLSearchParams) {
    return params.toString();
  }

  const parts: string[] = [];

  function encode(prefix: string, value: unknown, seen?: WeakSet<object>): void {
    if (value === null || value === undefined) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === 'object' && item !== null) {
          encode(`${prefix}[${index}]`, item, seen);
        } else {
          encode(prefix, item, seen);
        }
      });
    } else if (typeof value === 'object' && !(value instanceof Date)) {
      const visited = seen ?? new WeakSet<object>();
      // Tracks the current *path*, not everything ever seen: releasing the mark on the way
      // out still breaks cycles, while letting the same object appear under two different
      // keys (`{ a: shared, b: shared }`) serialize both times instead of dropping one.
      withCycleGuard(
        value,
        visited,
        () => {
          Object.keys(value as Record<string, unknown>).forEach((key) => {
            encode(`${prefix}[${key}]`, (value as Record<string, unknown>)[key], visited);
          });
        },
        () => {},
      );
    } else {
      const encodedValue = value instanceof Date ? value.toISOString() : value;
      parts.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(encodedValue as string)}`);
    }
  }

  const rootSeen = new WeakSet<object>();
  if (typeof params === 'object' && params !== null) {
    rootSeen.add(params);
  }

  Object.keys(params).forEach((key) => {
    encode(key, params[key], rootSeen);
  });

  return parts.join('&');
}

function combineURLs(baseURL: string, relativeURL: string): string {
  if (!baseURL) return relativeURL || '';
  if (!relativeURL) return baseURL;

  let baseEnd = baseURL.length;
  while (baseEnd > 0 && baseURL[baseEnd - 1] === '/') baseEnd--;

  let relStart = 0;
  while (relStart < relativeURL.length && relativeURL[relStart] === '/') relStart++;

  return `${baseURL.slice(0, baseEnd)}/${relativeURL.slice(relStart)}`;
}

function isAbsoluteURL(url: string): boolean {
  return /^([a-z][a-z\d+\-.]*:)/i.test(url);
}

export default function buildURL(
  url: string,
  baseURL?: string,
  params?: Record<string, unknown>,
  paramsSerializer?: ParamsSerializer,
): string {
  let fullURL = baseURL && !isAbsoluteURL(url) ? combineURLs(baseURL, url) : url || '';

  let finalParams = params;
  if (params && typeof params === 'object' && !(params instanceof URLSearchParams)) {
    if (fullURL.includes('{') || /(?:^|\/):[a-zA-Z_]/.test(fullURL)) {
      const unusedParams: Record<string, unknown> = {};
      for (const key of Object.keys(params)) {
        if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
        unusedParams[key] = (params as Record<string, unknown>)[key];
      }
      // `:name` only matches a whole path segment (bounded by `/`, `?`, `#`, or the URL
      // ends) so literal colon-suffixed segments like `files/123:download` aren't mistaken
      // for a `:download` placeholder and corrupted.
      fullURL = fullURL.replace(
        /(^|\/):([a-zA-Z_][a-zA-Z0-9_]*)(?=\/|\?|#|$)|\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g,
        (match, prefix, colonName, curlyName) => {
          const key = colonName || curlyName;
          if (key && Object.hasOwn(unusedParams, key) && unusedParams[key] !== undefined) {
            const val = unusedParams[key];
            delete unusedParams[key];
            const encoded = encodeURIComponent(String(val));
            return colonName !== undefined ? `${prefix}${encoded}` : encoded;
          }
          return match;
        },
      );
      finalParams = unusedParams;
    }
  }

  const serialized = serializeParams(finalParams as Record<string, unknown>, paramsSerializer);
  if (serialized) {
    const hashIndex = fullURL.indexOf('#');
    let fragment = '';
    if (hashIndex !== -1) {
      fragment = fullURL.slice(hashIndex);
      fullURL = fullURL.slice(0, hashIndex);
    }
    fullURL += (fullURL.indexOf('?') === -1 ? '?' : '&') + serialized + fragment;
  }

  return fullURL;
}

export { combineURLs, isAbsoluteURL, serializeParams };
