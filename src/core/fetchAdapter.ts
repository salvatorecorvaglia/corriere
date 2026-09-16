import parseHeaders from '../helpers/parseHeaders';
import type { CorriereRequestConfig, CorriereResponse } from '../types';
import CorriereError from './corriereError';
import { assertAllowedProtocol } from './protocol';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Headers that must not be replayed to a different origin after a redirect.
 *
 * Exported because `autoPaginate` needs the same list: an API's `next` link is an
 * unvalidated, server-controlled URL, which is exactly the situation a redirect hop is.
 */
export const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Follows redirects manually so each hop can be re-validated against the protocol
 * allow-list, and so credentials are dropped when a redirect crosses origins.
 *
 * Only engaged when `config.maxRedirects` is set. Left unset, `fetch` follows redirects
 * itself and intermediate hops are NOT re-checked — the allow-list then applies to the
 * initial URL only.
 */
async function fetchFollowingRedirects(
  config: CorriereRequestConfig,
  fetchImpl: typeof fetch,
  startURL: string,
  fetchOptions: RequestInit,
): Promise<Response> {
  const max = config.maxRedirects;

  if (max === undefined) {
    return await fetchImpl(startURL, fetchOptions);
  }

  if (typeof max !== 'number' || !Number.isInteger(max) || max < 0) {
    throw new CorriereError(
      `Invalid maxRedirects value: ${max}. Expected a non-negative integer.`,
      CorriereError.ERR_BAD_OPTION_VALUE,
      config,
      null,
      null,
    );
  }

  let currentURL = startURL;
  let method = (fetchOptions.method || 'GET').toUpperCase();
  let body = fetchOptions.body;
  const headers = new Headers(fetchOptions.headers as HeadersInit | undefined);

  for (let hop = 0; ; hop++) {
    // A fresh Headers per hop: `headers` is mutated between hops (credentials are dropped
    // on cross-origin redirects), and sharing one instance would retroactively alter the
    // headers already handed to an earlier fetch call.
    const response = await fetchImpl(currentURL, {
      ...fetchOptions,
      method,
      body,
      headers: new Headers(headers),
      redirect: 'manual',
    });

    // Browsers return an opaque stub for `redirect: 'manual'`: status 0, no Location,
    // unreadable body. Manual following is impossible there, so say so plainly rather
    // than silently returning an unusable response.
    if (response.type === 'opaqueredirect' || (response.status === 0 && !response.ok)) {
      throw new CorriereError(
        'config.maxRedirects is not supported in this environment: the fetch implementation ' +
          'returns opaque redirect responses. Omit maxRedirects to let fetch follow redirects.',
        CorriereError.ERR_NOT_SUPPORT,
        config,
        response,
        null,
      );
    }

    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get('location');
    // A 3xx with no Location is not actionable — hand it back and let validateStatus rule.
    if (!location) return response;

    // maxRedirects: 0 means "do not follow"; the 3xx itself is the result.
    if (max === 0) return response;

    if (hop >= max) {
      throw new CorriereError(
        `Maximum number of redirects exceeded (${max})`,
        CorriereError.ERR_FR_TOO_MANY_REDIRECTS,
        config,
        response,
        null,
      );
    }

    let nextURL: string;
    try {
      nextURL = new URL(location, currentURL).toString();
    } catch {
      throw new CorriereError(
        `Invalid redirect location: ${location}`,
        CorriereError.ERR_INVALID_URL,
        config,
        response,
        null,
      );
    }

    assertAllowedProtocol(nextURL, config);

    if (!sameOrigin(nextURL, currentURL)) {
      for (const name of CREDENTIAL_HEADERS) headers.delete(name);
    }

    // 303 always downgrades to GET; 301/302 do so for POST, matching fetch and browsers.
    // 307/308 preserve both method and body by definition.
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === 'POST')
    ) {
      method = 'GET';
      body = undefined;
      headers.delete('content-type');
      headers.delete('content-length');
    }

    // Cancel the discarded 3xx body so the connection is released.
    try {
      await response.body?.cancel();
    } catch {
      // ignore
    }

    currentURL = nextURL;
  }
}

async function readResponseData(
  fetchResponse: Response,
  config: CorriereRequestConfig,
): Promise<unknown> {
  const responseType = config.responseType || 'json';
  switch (responseType) {
    case 'arraybuffer':
      return await fetchResponse.arrayBuffer();
    case 'blob':
      return await fetchResponse.blob();
    case 'stream':
      return fetchResponse.body;
    case 'text':
      return await fetchResponse.text();
    default: {
      const contentType = fetchResponse.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const text = await fetchResponse.text();
        // An empty body is the absence of data. Returning '' meant `defaultTransformResponse`
        // then failed to parse it and handed the caller an empty string where a 204 or an
        // empty 200 plainly means "nothing".
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch (err) {
          throw new CorriereError(
            `Failed to parse JSON response: ${(err as Error).message}. Raw body: ${
              text.length > 500 ? `${text.slice(0, 500)}…` : text
            }`,
            CorriereError.ERR_BAD_RESPONSE,
            config,
            fetchResponse,
            null,
          );
        }
      }
      return await fetchResponse.text();
    }
  }
}

function assertValidURL(fullURL: string, config: CorriereRequestConfig): void {
  if (!fullURL || !/^[a-z][a-z\d+\-.]*:/i.test(fullURL)) return;
  try {
    new URL(fullURL);
  } catch {
    throw new CorriereError(
      `Invalid URL: ${fullURL}`,
      CorriereError.ERR_INVALID_URL,
      config,
      null,
      null,
    );
  }
}

interface AbortWiring {
  isTimedOut: () => boolean;
  cleanup: () => void;
}

function setupAbort(config: CorriereRequestConfig, fetchOptions: RequestInit): AbortWiring {
  if (
    config.timeout !== undefined &&
    (typeof config.timeout !== 'number' || Number.isNaN(config.timeout) || config.timeout < 0)
  ) {
    throw new CorriereError(
      `Invalid timeout value: ${config.timeout}`,
      CorriereError.ERR_BAD_OPTION_VALUE,
      config,
      null,
      null,
    );
  }

  const timeoutValue = Number(config.timeout);
  const hasTimeout = !Number.isNaN(timeoutValue) && timeoutValue > 0;

  if (!hasTimeout) {
    if (config.signal) fetchOptions.signal = config.signal;
    return { isTimedOut: () => false, cleanup: () => {} };
  }

  let timedOut = false;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    timedOut = true;
    abortController.abort(
      new CorriereError(
        `timeout of ${timeoutValue}ms exceeded`,
        CorriereError.ETIMEDOUT,
        config,
        null,
        null,
      ),
    );
  }, timeoutValue);

  // For `responseType: 'stream'` the timer is cleared when the stream finishes, so a
  // consumer that abandons the stream would otherwise leave a pending timer holding the
  // Node event loop open. An in-flight request is kept alive by its own socket, so
  // unref'ing the timer costs nothing while the request is genuinely running.
  (timeoutId as unknown as { unref?: () => void })?.unref?.();

  let onUserAbort: (() => void) | null = null;

  if (config.signal) {
    if (config.signal.aborted) {
      abortController.abort(config.signal.reason);
    } else {
      onUserAbort = () => {
        if (!timedOut) abortController.abort(config.signal!.reason);
      };
      config.signal.addEventListener('abort', onUserAbort, { once: true });
    }
    fetchOptions.signal = abortController.signal;
  } else {
    fetchOptions.signal = abortController.signal;
  }

  return {
    isTimedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeoutId);
      if (onUserAbort && config.signal) {
        config.signal.removeEventListener('abort', onUserAbort);
      }
    },
  };
}

function wrapResponseStream(fetchResponse: Response, config: CorriereRequestConfig): Response {
  const hasLimit = typeof config.maxContentLength === 'number' && config.maxContentLength > 0;
  const hasProgress = !!config.onDownloadProgress && config.responseType !== 'stream';

  if ((!hasLimit && !hasProgress) || !fetchResponse.body) {
    return fetchResponse;
  }

  const contentLength = fetchResponse.headers.get('content-length');
  const total = contentLength ? Number.parseInt(contentLength, 10) : 0;
  let loaded = 0;

  const reader = fetchResponse.body.getReader();
  // One chunk per `pull` — driven by consumer demand. Reading the whole body inside
  // `start` would discard backpressure and buffer the entire response in the controller's
  // queue, which defeats `responseType: 'stream'` for large payloads.
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        loaded += value.byteLength;

        if (hasLimit && loaded > config.maxContentLength!) {
          const limitError = new CorriereError(
            `maxContentLength size of ${config.maxContentLength} exceeded`,
            CorriereError.ERR_BAD_RESPONSE,
            config,
            fetchResponse,
            null,
          );
          controller.error(limitError);
          await reader.cancel(limitError).catch(() => {});
          return;
        }

        if (hasProgress) {
          config.onDownloadProgress!({ loaded, total });
        }

        controller.enqueue(value);
      } catch (e) {
        controller.error(e);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(stream, {
    headers: fetchResponse.headers,
    status: fetchResponse.status,
    statusText: fetchResponse.statusText,
  });
}

function classifyFetchError(
  error: unknown,
  config: CorriereRequestConfig,
  isTimedOut: boolean,
): CorriereError {
  if (error instanceof CorriereError) return error;

  if (isTimedOut) {
    return new CorriereError(
      `timeout of ${config.timeout}ms exceeded`,
      CorriereError.ETIMEDOUT,
      config,
      null,
      null,
    );
  }

  const isAbort =
    (error instanceof Error && error.name === 'AbortError') || !!config.signal?.aborted;
  if (isAbort) {
    const reason = config.signal?.reason;
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : 'Request aborted';
    const err = new CorriereError(message, CorriereError.ERR_CANCELED, config, null, null);
    if (reason instanceof Error) {
      err.cause = reason;
    }
    return err;
  }

  return CorriereError.from(
    error instanceof Error ? error : new Error(String(error)),
    CorriereError.ERR_NETWORK,
    config,
    null,
    null,
  );
}

/**
 * Module-level on purpose. A registry created per stream becomes unreachable as soon as
 * the wrapping function returns, and the spec does not require an unreachable registry's
 * callbacks to ever run — the GC-based fallback silently never fired.
 */
const streamCleanupRegistry =
  typeof FinalizationRegistry !== 'undefined'
    ? new FinalizationRegistry((cleanupFn: () => void) => {
        cleanupFn();
      })
    : null;

function wrapStreamWithCleanup(stream: any, cleanup: () => void): any {
  if (!stream) return stream;

  let cleaned = false;
  const onceCleanup = () => {
    if (!cleaned) {
      cleaned = true;
      cleanup();
    }
  };

  streamCleanupRegistry?.register(stream, onceCleanup);

  if (typeof stream.cancel === 'function') {
    const originalCancel = stream.cancel;
    stream.cancel = async (...args: any[]) => {
      try {
        return await originalCancel.apply(stream, args);
      } finally {
        onceCleanup();
      }
    };
  }

  // If it has a cancel method (Web Stream)
  if (typeof stream.getReader === 'function') {
    const originalGetReader = stream.getReader;
    stream.getReader = (...args: any[]) => {
      const reader = originalGetReader.apply(stream, args);
      const originalRead = reader.read;
      const originalCancel = reader.cancel;

      reader.read = async () => {
        try {
          const result = await originalRead.call(reader);
          if (result.done) {
            onceCleanup();
          }
          return result;
        } catch (err) {
          onceCleanup();
          throw err;
        }
      };

      reader.cancel = async (...cancelArgs: any[]) => {
        try {
          return await originalCancel.apply(reader, cancelArgs);
        } finally {
          onceCleanup();
        }
      };

      return reader;
    };
  }

  // If it supports Symbol.asyncIterator (Node or Web Stream async iteration)
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    const originalAsyncIterator = stream[Symbol.asyncIterator];
    stream[Symbol.asyncIterator] = () => {
      const iterator = originalAsyncIterator.call(stream);
      const originalNext = iterator.next;
      const originalReturn = iterator.return;
      const originalThrow = iterator.throw;

      iterator.next = async (...nextArgs: any[]) => {
        try {
          const result = await originalNext.apply(iterator, nextArgs);
          if (result.done) {
            onceCleanup();
          }
          return result;
        } catch (err) {
          onceCleanup();
          throw err;
        }
      };

      if (originalReturn) {
        iterator.return = async (...returnArgs: any[]) => {
          try {
            return await originalReturn.apply(iterator, returnArgs);
          } finally {
            onceCleanup();
          }
        };
      }

      if (originalThrow) {
        iterator.throw = async (...throwArgs: any[]) => {
          try {
            return await originalThrow.apply(iterator, throwArgs);
          } finally {
            onceCleanup();
          }
        };
      }

      return iterator;
    };
  }

  // If it's a Node stream (EventEmitter)
  if (typeof stream.on === 'function') {
    stream.on('end', onceCleanup);
    stream.on('close', onceCleanup);
    stream.on('error', onceCleanup);
  }

  return stream;
}

export default async function fetchAdapter(
  config: CorriereRequestConfig,
  fullURL: string,
  fetchOptions: RequestInit,
  requestStartTime: number,
): Promise<CorriereResponse> {
  assertValidURL(fullURL, config);

  const abort = setupAbort(config, fetchOptions);
  let isStream = false;

  try {
    const fetchImpl = config.fetch || fetch;
    const rawResponse = await fetchFollowingRedirects(config, fetchImpl, fullURL, fetchOptions);

    // Checked before wrapping: `wrapResponseStream` locks the body with `getReader()`, and
    // bailing out afterwards left that reader dangling with the connection unreleased.
    const contentLength = rawResponse.headers.get('content-length');
    if (
      contentLength &&
      config.maxContentLength &&
      Number.parseInt(contentLength, 10) > config.maxContentLength
    ) {
      await rawResponse.body?.cancel().catch(() => {});
      throw new CorriereError(
        `maxContentLength size of ${config.maxContentLength} exceeded`,
        CorriereError.ERR_BAD_RESPONSE,
        config,
        rawResponse,
        null,
      );
    }

    const fetchResponse = wrapResponseStream(rawResponse, config);

    let responseData: unknown;
    try {
      responseData = await readResponseData(fetchResponse, config);
      if (config.responseType === 'stream') {
        isStream = true;
        responseData = wrapStreamWithCleanup(responseData, abort.cleanup);
      }
      // `config.schema` is applied later, in the request pipeline, so it validates the data
      // the caller actually receives — after `transformResponse` and after the status check.
    } catch (readError) {
      if (readError instanceof CorriereError) throw readError;
      throw CorriereError.from(
        readError as Error,
        CorriereError.ERR_BAD_RESPONSE,
        config,
        fetchResponse,
        null,
      );
    }

    return {
      data: responseData,
      status: fetchResponse.status,
      statusText: fetchResponse.statusText,
      headers: parseHeaders(fetchResponse.headers),
      config,
      request: fetchResponse,
      duration: Date.now() - requestStartTime,
    };
  } catch (error) {
    throw classifyFetchError(error, config, abort.isTimedOut());
  } finally {
    if (!isStream) {
      abort.cleanup();
    }
  }
}
