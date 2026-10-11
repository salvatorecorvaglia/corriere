import { isAbsoluteURL } from '../core/buildURL';
import CorriereError from '../core/corriereError';
import { CREDENTIAL_HEADERS } from '../core/fetchAdapter';
import mergeConfig from '../core/mergeConfig';
import type { CorriereRequestConfig, CorriereResponse, InternalConfig } from '../types';

/** What pagination needs from a client: its defaults, and a way to fetch one page. */
export interface PaginationClient {
  defaults: CorriereRequestConfig;
  get<T = any>(url: string, config?: CorriereRequestConfig): Promise<CorriereResponse<T>>;
}

function originOf(absoluteURL: string): string | null {
  try {
    return new URL(absoluteURL).origin;
  } catch {
    return null;
  }
}

/**
 * Removes credentials from a config about to be sent to a different origin.
 *
 * `autoPaginate` follows a `next` link chosen by the server. That is the same trust
 * situation as a redirect hop, so it gets the same treatment the redirect follower already
 * applies: `Authorization`, `Cookie` and `Proxy-Authorization` are dropped, along with
 * `auth`, which would otherwise regenerate the `Authorization` header downstream.
 *
 * Copies rather than mutates, since the caller's config object is theirs.
 */
function withoutCredentials(config: CorriereRequestConfig): CorriereRequestConfig {
  const stripped: CorriereRequestConfig = { ...config, auth: undefined };
  if (!stripped.headers || typeof stripped.headers !== 'object') return stripped;

  const isCredential = (key: string) => CREDENTIAL_HEADERS.includes(key.toLowerCase());
  const headers: Record<string, unknown> = { ...(stripped.headers as Record<string, unknown>) };

  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (isCredential(key)) {
      delete headers[key];
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Method-group form (`{ common: {…}, get: {…} }`) nests exactly one level.
      const group: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      for (const inner of Object.keys(group)) {
        if (isCredential(inner)) delete group[inner];
      }
      headers[key] = group;
    }
  }

  stripped.headers = headers as CorriereRequestConfig['headers'];
  return stripped;
}

function assertPaginateHostAllowed(
  nextURL: string,
  nextOrigin: string,
  allowedHosts: string[] | null | undefined,
  config: CorriereRequestConfig,
): void {
  if (allowedHosts === null) return;
  const allowed = allowedHosts ?? [];
  const host = originOf(nextURL) === nextOrigin ? new URL(nextURL).host : '';
  if (allowed.includes(host)) return;

  throw new CorriereError(
    `Pagination refused to follow a cross-origin next link to "${nextOrigin}". ` +
      'The link is chosen by the server being paginated, so following it would send your ' +
      'request there. Add the host to config.allowedPaginateHosts to permit it (credentials ' +
      'are dropped either way), or set allowedPaginateHosts to null to disable this check.',
    CorriereError.ERR_BAD_OPTION,
    config,
    null,
    null,
  );
}

/**
 * Follows a paginated API page by page, yielding each page's items. The engine behind
 * `Corriere.autoPaginate()`; every page is fetched through `client.get`, so instance
 * defaults, interceptors, retries and caching all apply.
 */
export async function* paginate<T = any>(
  client: PaginationClient,
  url: string,
  config?: CorriereRequestConfig,
): AsyncGenerator<T, void, unknown> {
  let nextUrl: string | null = url;
  let currentConfig: InternalConfig = config || {};

  // The pagination options themselves are resolved against the instance defaults, so a
  // client created with `{ maxPages, paginateItems, allowedPaginateHosts }` honours them.
  // Only the options are read from this merge; each page is still requested through
  // `this.get`, which applies the defaults itself.
  const options = mergeConfig(client.defaults, config);
  const { paginateItems, allowedPaginateHosts } = options;

  // An API that returns a `next` link pointing at the current (or an earlier) page would
  // otherwise spin forever. Both guards are needed: `visited` catches tight cycles
  // immediately, `maxPages` bounds chains that never repeat a URL but never end either.
  const maxPages = options.maxPages ?? 1000;
  const visited = new Set<string>();
  let pageCount = 0;

  // Cycle detection compares a normalized (absolute) form of each URL, so an API that
  // alternates between relative and absolute forms of the same page is still caught —
  // not just a byte-for-byte repeat.
  const normalizeForCycleCheck = (raw: string): string => {
    try {
      return new URL(
        raw,
        currentConfig.baseURL || client.defaults.baseURL || 'http://dummy-base.invalid',
      ).href;
    } catch {
      return raw;
    }
  };

  // Every later page is judged against where pagination started, not against the previous
  // hop — otherwise a chain of same-looking single steps could walk anywhere.
  const initialOrigin = originOf(normalizeForCycleCheck(url));

  while (nextUrl) {
    const cycleKey = normalizeForCycleCheck(nextUrl);
    if (visited.has(cycleKey)) {
      throw new CorriereError(
        `Pagination cycle detected: ${nextUrl} was already requested. ` +
          'Check the `next` link returned by the API.',
        CorriereError.ERR_BAD_RESPONSE,
        currentConfig,
        null,
        null,
      );
    }
    visited.add(cycleKey);

    if (++pageCount > maxPages) {
      throw new CorriereError(
        `Pagination exceeded maxPages (${maxPages}). Raise config.maxPages if this is expected.`,
        CorriereError.ERR_BAD_RESPONSE,
        currentConfig,
        null,
        null,
      );
    }

    const response: CorriereResponse<any> = await client.get(nextUrl, currentConfig);

    const data = response.data;
    let items: any = null;

    if (paginateItems) {
      if (typeof paginateItems === 'function') {
        items = paginateItems(data);
      } else if (typeof paginateItems === 'string' && data && typeof data === 'object') {
        items = (data as any)[paginateItems];
      }
    } else {
      items = Array.isArray(data)
        ? data
        : data && typeof data === 'object'
          ? (data as any).data || (data as any).items || (data as any).results || null
          : null;
    }

    if (Array.isArray(items)) {
      for (const item of items) {
        yield item;
      }
    }

    nextUrl =
      data && typeof data === 'object'
        ? (data as any).next || (data as any).links?.next || null
        : null;

    if (nextUrl) {
      let merged: InternalConfig = { ...currentConfig, url: nextUrl };
      if (merged.params) {
        merged.params = { ...merged.params };
        try {
          const dummyBase = 'http://dummy-base.com';
          const parsedUrl = new URL(nextUrl, dummyBase);
          for (const key of parsedUrl.searchParams.keys()) {
            delete merged.params[key];
          }
        } catch {
          merged.params = {};
        }
      }

      // The `next` link is server-controlled. Left unchecked it can walk the client — and
      // whatever credentials the config carries — onto an arbitrary host.
      const nextOrigin = originOf(normalizeForCycleCheck(nextUrl));
      if (nextOrigin && initialOrigin && nextOrigin !== initialOrigin) {
        assertPaginateHostAllowed(
          normalizeForCycleCheck(nextUrl),
          nextOrigin,
          allowedPaginateHosts,
          currentConfig,
        );
        // `withoutCredentials` scrubs the per-call config, but the instance defaults are
        // merged back in by `request()` and interceptors run after that. The flag makes
        // the transport drop credential headers and basic auth from the *final* headers,
        // and `withCredentials: false` overrides an instance-level `true`. It stays set
        // for the rest of the chain: once pagination has left the starting origin,
        // credentials are never re-attached.
        merged = { ...withoutCredentials(merged), withCredentials: false };
        merged._stripCredentials = true;
      }

      // `next` links are commonly absolute. Where pagination may go is governed by the
      // origin check above (`allowedPaginateHosts`), so `allowAbsoluteUrls: false` — which
      // pins the caller's own `url` to `baseURL` — does not also refuse a vetted link.
      if (isAbsoluteURL(nextUrl)) {
        merged.allowAbsoluteUrls = true;
      }

      currentConfig = merged;
    }
  }
}
