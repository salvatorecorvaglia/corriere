import { validateStreamLimits } from '../features/stream';
import { setBasicAuth } from '../helpers/auth';
import { CREDENTIAL_HEADERS } from '../helpers/credentialHeaders';
import { logRequest } from '../helpers/debug';
import { buildFetchHeaders, flattenHeaders, removeContentType } from '../helpers/flattenHeaders';
import { isReadableStream } from '../helpers/isBinary';
import transformData from '../helpers/transformData';
import type { CorriereRequestConfig, InternalConfig } from '../types';
import { resolveURL } from './buildURL';
import CorriereError from './corriereError';
import { assertAllowedProtocol } from './protocol';

type FlatHeaders = Record<string, string | string[]>;
type FetchOptions = RequestInit & { duplex?: 'half'; dispatcher?: unknown; agent?: unknown };

export interface PreparedRequest {
  config: CorriereRequestConfig;
  url: string;
  headers: FlatHeaders;
  options: FetchOptions;
}

function checkCancellation(config: CorriereRequestConfig): void {
  if (config.signal?.aborted) throw CorriereError.canceled(config.signal.reason, config);
}

export function requestHeaders(config: CorriereRequestConfig): FlatHeaders {
  const headers = flattenHeaders(
    config.headers as Parameters<typeof flattenHeaders>[0],
    config.method,
  );
  if (!(config as InternalConfig)._stripCredentials) setBasicAuth(config, headers);
  return headers;
}

/** Apply transport header rules after transforms, including the pagination boundary. */
export function finishHeaders(
  headers: FlatHeaders,
  data: unknown,
  config: CorriereRequestConfig,
): void {
  if (data == null || (typeof FormData !== 'undefined' && data instanceof FormData)) {
    removeContentType(headers);
  }
  if ((config as InternalConfig)._stripCredentials) {
    for (const key of Object.keys(headers)) {
      if (CREDENTIAL_HEADERS.includes(key.toLowerCase())) delete headers[key];
    }
  }
}

/** Prepare each caller independently before cache lookup or deduplication. */
export async function prepareRequest(config: CorriereRequestConfig): Promise<PreparedRequest> {
  checkCancellation(config);
  await config.hooks?.onBeforeRequest?.(config);
  checkCancellation(config);

  const headers = requestHeaders(config);
  const data = await transformData(config.transformRequest, config.data, headers, config);
  checkCancellation(config);
  finishHeaders(headers, data, config);
  if (config.responseType === 'stream') validateStreamLimits(config);

  // Hooks and transforms may change URL inputs; only the final result is used for
  // transport, logging, protocol validation, and sharing identity.
  const url = resolveURL(config);
  assertAllowedProtocol(url, config);
  const options: FetchOptions = {
    method: (config.method || 'GET').toUpperCase(),
    headers: buildFetchHeaders(headers),
  };
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(options.method!) && data != null) {
    options.body = data as BodyInit;
    if (isReadableStream(data)) options.duplex = 'half';
  }
  if (config.withCredentials && !(config as InternalConfig)._stripCredentials)
    options.credentials = 'include';
  if (config.dispatcher) options.dispatcher = config.dispatcher;
  if (config.agent) options.agent = config.agent;
  logRequest(config, url);
  return { config, url, headers, options };
}
