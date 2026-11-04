import { isAbsoluteURL, resolveURL } from '../core/buildURL';
import CorriereError, { redactURL } from '../core/corriereError';
import mergeConfig from '../core/mergeConfig';
import { requestURLFor, responseURLFor } from '../core/responseURL';
import { CREDENTIAL_HEADERS } from '../helpers/credentialHeaders';
import type { CorriereRequestConfig, CorriereResponse, InternalConfig } from '../types';

/** What pagination needs from a client: its defaults, and a way to fetch one page. */
export interface PaginationClient {
  defaults: CorriereRequestConfig;
  get<T = any>(url: string, config?: CorriereRequestConfig): Promise<CorriereResponse<T>>;
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
  target: URL,
  allowedHosts: string[] | null | undefined,
  config: CorriereRequestConfig,
): void {
  if (allowedHosts === null) return;
  const allowed = allowedHosts ?? [];
  if (allowed.includes(target.host)) return;

  throw new CorriereError(
    `Pagination refused to follow a cross-origin next link to "${target.origin}". ` +
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
  // while `maxPages` bounds chains that never repeat a URL but never end either.
  const maxPages = options.maxPages === undefined ? 1000 : options.maxPages;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new CorriereError(
      'maxPages must be a positive safe integer.',
      CorriereError.ERR_BAD_OPTION_VALUE,
      options,
      null,
      null,
    );
  }
  const visited = new Set<string>();
  const candidates = new Set<string>();
  let pageCount = 0;
  let initialOrigin: string | null = null;
  const reference = typeof location !== 'undefined' ? location.href : 'http://corriere.invalid';
  const normalize = (raw: string): string => {
    try {
      const parsed = new URL(raw, reference);
      parsed.hash = '';
      return parsed.href;
    } catch {
      // The request pipeline reports malformed initial URLs with redacted errors.
      return raw;
    }
  };
  const cycleError = () =>
    new CorriereError(
      `Pagination cycle detected: ${redactURL(nextUrl!)} was already requested. Check the next link returned by the API.`,
      CorriereError.ERR_BAD_RESPONSE,
      currentConfig,
      null,
      null,
    );

  while (nextUrl) {
    const candidate = normalize(nextUrl);
    if (visited.has(candidate) || candidates.has(candidate)) throw cycleError();
    candidates.add(candidate);
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
    // Use transport metadata instead of rebuilding the URL: rebuilding would run
    // custom serializers twice and could miss changes made by hooks or transforms.
    const requestedURL = requestURLFor(response.request) ?? resolveURL(response.config);
    const pageURL = new URL(responseURLFor(response.request) ?? requestedURL, reference);
    const effective = normalize(pageURL.href);
    if (visited.has(effective)) throw cycleError();
    visited.add(effective);
    visited.add(normalize(requestedURL));
    initialOrigin ??= new URL(requestedURL, reference).origin;

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

    const link = data && typeof data === 'object' ? (data.next ?? data.links?.next ?? null) : null;
    if (link === null || link === '') return;
    if (typeof link !== 'string') {
      throw new CorriereError(
        'Pagination next link must be a URL string.',
        CorriereError.ERR_BAD_RESPONSE,
        currentConfig,
        null,
        null,
      );
    }
    let target: URL;
    try {
      target = new URL(link, pageURL);
    } catch {
      throw new CorriereError(
        'Pagination next link is not a valid URL.',
        CorriereError.ERR_BAD_RESPONSE,
        currentConfig,
        null,
        null,
      );
    }
    if (target.username || target.password) {
      throw new CorriereError(
        'Pagination next link must not contain URL credentials.',
        CorriereError.ERR_BAD_RESPONSE,
        currentConfig,
        null,
        null,
      );
    }
    // Relative-only custom transports in Node have no browser origin to resolve
    // against. Keep their links relative rather than sending the synthetic reference.
    nextUrl =
      !isAbsoluteURL(requestedURL) &&
      typeof location === 'undefined' &&
      target.origin === pageURL.origin
        ? `${target.pathname}${target.search}${target.hash}`
        : target.href;
    let merged: InternalConfig = {
      ...currentConfig,
      url: nextUrl,
      allowAbsoluteUrls: true,
      _paginateQueryKeys: [
        ...new Set([...(currentConfig._paginateQueryKeys ?? []), ...target.searchParams.keys()]),
      ],
    };
    if (target.origin !== initialOrigin) {
      assertPaginateHostAllowed(target, allowedPaginateHosts, currentConfig);
      merged = { ...withoutCredentials(merged), withCredentials: false, _stripCredentials: true };
    }
    currentConfig = merged;
  }
}
