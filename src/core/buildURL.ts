import { ERR_BAD_OPTION } from '../constants/errorCodes';
import { withCycleGuard } from '../helpers/cycleGuard';
import type { CorriereRequestConfig, InternalConfig, ParamsSerializer } from '../types';
import CorriereError, { redactURL } from './corriereError';

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

    if (typeof value === 'object' && !(value instanceof Date)) {
      const visited = seen ?? new WeakSet<object>();
      // Guard arrays and objects on the current path, allowing shared references
      // to be serialized again after the traversal leaves that path.
      withCycleGuard(
        value,
        visited,
        () => {
          if (Array.isArray(value)) {
            value.forEach((item, index) => {
              encode(
                typeof item === 'object' && item !== null ? `${prefix}[${index}]` : prefix,
                item,
                visited,
              );
            });
          } else {
            Object.keys(value as Record<string, unknown>).forEach((key) => {
              encode(`${prefix}[${key}]`, (value as Record<string, unknown>)[key], visited);
            });
          }
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

/**
 * The full URL a config will be sent to. Every place that needs it goes through here, so
 * `allowAbsoluteUrls` is enforced for requests, `getUri` and cache keys alike.
 */
/**
 * Whether the final `url` stays inside `baseURL`: same origin, and a path at or below the
 * base path. Both are parsed first, so `..` segments are resolved before the comparison and
 * `/v10` does not count as being under `/v1`. A `baseURL` that cannot be parsed on its own
 * (a relative one, such as `/api`) contains nothing absolute.
 */
function isWithinBaseURL(url: string, baseURL: string): boolean {
  try {
    // Relative browser bases need the same path check, without treating an
    // absolute target as belonging to a relative base.
    if (!isAbsoluteURL(baseURL) && isAbsoluteURL(url)) return false;
    const reference = 'http://corriere.invalid';
    const target = new URL(url, reference);
    const base = new URL(baseURL, reference);
    if (target.origin !== base.origin) return false;
    const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
    return target.pathname === base.pathname || target.pathname.startsWith(basePath);
  } catch {
    return false;
  }
}

export function resolveURL(config: CorriereRequestConfig): string {
  const url = config.url ?? '';
  let params = config.params;
  const omittedKeys = (config as InternalConfig)._paginateQueryKeys;
  if (params && omittedKeys?.length) {
    params = { ...params };
    for (const key of omittedKeys) delete params[key];
  }
  const fullURL = buildURL(url, config.baseURL, params, config.paramsSerializer);
  // Apply the same path placeholders to the boundary, without serializing query
  // parameters or invoking the caller's serializer a second time.
  const baseURL = config.baseURL && buildURL(config.baseURL, undefined, params, () => '');
  // Check after joining and substitution: relative paths and template values can
  // contain dot segments that Fetch normalizes outside the configured base path.
  if (
    config.allowAbsoluteUrls !== true &&
    config.baseURL &&
    !isWithinBaseURL(fullURL, baseURL || config.baseURL)
  ) {
    throw new CorriereError(
      `Request URL "${redactURL(fullURL)}" is outside baseURL "${redactURL(config.baseURL)}". ` +
        'Set allowAbsoluteUrls to true to permit requests outside baseURL.',
      ERR_BAD_OPTION,
      config,
      null,
      null,
    );
  }
  return fullURL;
}

export { combineURLs, isAbsoluteURL, serializeParams };
