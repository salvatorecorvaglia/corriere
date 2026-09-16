import ErrorCodes from '../constants/errorCodes';
import { withCycleGuard } from '../helpers/cycleGuard';
import type { CorriereRequestConfig, CorriereResponse, InternalConfig } from '../types';

function redactHeaders(headers: unknown, seen?: WeakSet<object>): unknown {
  if (!headers || typeof headers !== 'object') return headers;
  const visited = seen ?? new WeakSet<object>();
  return withCycleGuard<unknown>(
    headers as object,
    visited,
    () => {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(headers as Record<string, unknown>)) {
        const value = (headers as Record<string, unknown>)[key];
        if (
          /^authorization$/i.test(key) ||
          /^proxy-authorization$/i.test(key) ||
          /^cookie$/i.test(key) ||
          /^set-cookie$/i.test(key) ||
          /^x-api-key$/i.test(key) ||
          /^api-key$/i.test(key)
        ) {
          out[key] = '[REDACTED]';
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
          out[key] = redactHeaders(value, visited);
        } else {
          out[key] = value;
        }
      }
      return out;
    },
    () => '[Circular]',
  );
}

const SENSITIVE_BODY_KEY =
  /^(password|passwd|pwd|token|access_token|refresh_token|id_token|authorization|api[_-]?key|secret|client[_-]?secret|cookie|set[_-]?cookie|private[_-]?key|session)$/i;

export function redactBody(value: unknown, seen?: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;

  // Guard against binary formats, streams, buffers to prevent heavy serialization
  if (
    (typeof File !== 'undefined' && value instanceof File) ||
    (typeof Blob !== 'undefined' && value instanceof Blob) ||
    (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) ||
    (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) ||
    (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) ||
    (typeof ReadableStream !== 'undefined' && value instanceof ReadableStream)
  ) {
    return '[Binary/Stream Data]';
  }

  // FormData stores its entries internally, not as own-enumerable properties, so the
  // generic object walk below would see it as empty (`{}`) rather than reporting its
  // actual (possibly sensitive) contents or an honest placeholder.
  if (typeof FormData !== 'undefined' && value instanceof FormData) {
    return '[FormData]';
  }

  const visited = seen ?? new WeakSet<object>();
  return withCycleGuard<unknown>(
    value as object,
    visited,
    () => {
      if (Array.isArray(value)) {
        if (value.length > 100) {
          const sliced = value.slice(0, 100).map((item) => redactBody(item, visited));
          sliced.push(`[... ${value.length - 100} more items truncated]`);
          return sliced;
        }
        return value.map((item) => redactBody(item, visited));
      }

      const out: Record<string, unknown> = {};
      const keys = Object.keys(value as Record<string, unknown>);

      if (keys.length > 100) {
        let count = 0;
        for (const key of keys) {
          if (count >= 100) {
            out['...'] = `[Truncated: ${keys.length - 100} more keys]`;
            break;
          }
          const v = (value as Record<string, unknown>)[key];
          if (SENSITIVE_BODY_KEY.test(key)) {
            out[key] = '[REDACTED]';
          } else {
            out[key] = redactBody(v, visited);
          }
          count++;
        }
        return out;
      }

      for (const key of keys) {
        const v = (value as Record<string, unknown>)[key];
        if (SENSITIVE_BODY_KEY.test(key)) {
          out[key] = '[REDACTED]';
        } else {
          out[key] = redactBody(v, visited);
        }
      }
      return out;
    },
    () => '[Circular]',
  );
}

export function redactParams(params: unknown, seen?: WeakSet<object>): unknown {
  if (!params || typeof params !== 'object') return params;
  const visited = seen ?? new WeakSet<object>();
  return withCycleGuard<unknown>(
    params as object,
    visited,
    () => {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(params as Record<string, unknown>)) {
        const value = (params as Record<string, unknown>)[key];
        if (SENSITIVE_BODY_KEY.test(key)) {
          out[key] = '[REDACTED]';
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
          out[key] = redactParams(value, visited);
        } else {
          out[key] = value;
        }
      }
      return out;
    },
    () => '[Circular]',
  );
}

export function redactURL(url: string | undefined): string | undefined {
  if (!url) return url;
  // Match inline credentials: http://user:pass@host
  let redacted = url.replace(/^([a-z][a-z\d+\-.]*:\/\/)([^/]+)@/i, (_match, protocol, userInfo) => {
    const parts = userInfo.split(':');
    if (parts.length > 1) {
      return `${protocol}${parts[0]}:[REDACTED]@`;
    }
    return `${protocol}[REDACTED]@`;
  });

  // Redact sensitive query parameters
  const qIndex = redacted.indexOf('?');
  if (qIndex !== -1) {
    const base = redacted.slice(0, qIndex);
    const query = redacted.slice(qIndex + 1);
    const hashIndex = query.indexOf('#');
    let search = query;
    let hash = '';
    if (hashIndex !== -1) {
      search = query.slice(0, hashIndex);
      hash = query.slice(hashIndex);
    }
    const parts = search.split('&');
    const redactedParts = parts.map((part) => {
      const eqIndex = part.indexOf('=');
      if (eqIndex === -1) return part;
      const key = part.slice(0, eqIndex);
      let decodedKey = key;
      try {
        decodedKey = decodeURIComponent(key);
      } catch {
        // Malformed percent-encoding: fall back to the raw key rather than throwing out
        // of a getter (`error.config`) that callers reasonably expect to never fail.
      }
      if (SENSITIVE_BODY_KEY.test(decodedKey)) {
        return `${key}=[REDACTED]`;
      }
      return part;
    });
    redacted = `${base}?${redactedParts.join('&')}${hash}`;
  }
  return redacted;
}

/**
 * Strips credentials from a config before it is attached to an error.
 *
 * Errors routinely get serialized into logs and crash reporters, so every field that can
 * carry a secret is scrubbed: headers, query params, inline URL credentials, and the
 * request body. Applies to errors only — a successful `response.config` is returned
 * unredacted so callers can read back the headers and body they sent.
 */
export function redactConfig(config: CorriereRequestConfig | null): CorriereRequestConfig | null {
  if (!config) return config;
  const clone = { ...config } as CorriereRequestConfig & { auth?: unknown };
  if ('auth' in clone) clone.auth = undefined;
  if (clone.headers) clone.headers = redactHeaders(clone.headers) as typeof clone.headers;
  if (clone.params) clone.params = redactParams(clone.params) as typeof clone.params;
  if (clone.data !== undefined && clone.data !== null) clone.data = redactBody(clone.data);
  if (clone.url) clone.url = redactURL(clone.url);
  if (clone.baseURL) clone.baseURL = redactURL(clone.baseURL);
  const internal = clone as InternalConfig;
  if (internal._builtUrl) internal._builtUrl = redactURL(internal._builtUrl);
  return clone;
}

/**
 * Marks an error that came from replaying a cached response rather than from a live
 * request. `retryRequest` refuses to retry these: every attempt would read back the same
 * cache entry and fail identically, so the caller would pay the full backoff schedule
 * without the request ever reaching the network.
 *
 * A symbol rather than a field so it never shows up in `toJSON()`, `console.log` output,
 * or a user's `Object.keys(error)`.
 */
export const FROM_CACHE = Symbol('corriere.fromCache');

export class CorriereError extends Error {
  static ERR_BAD_OPTION_VALUE: string = ErrorCodes.ERR_BAD_OPTION_VALUE;
  static ERR_BAD_OPTION: string = ErrorCodes.ERR_BAD_OPTION;
  static ECONNABORTED: string = ErrorCodes.ECONNABORTED;
  static ETIMEDOUT: string = ErrorCodes.ETIMEDOUT;
  static ERR_NETWORK: string = ErrorCodes.ERR_NETWORK;
  static ERR_FR_TOO_MANY_REDIRECTS: string = ErrorCodes.ERR_FR_TOO_MANY_REDIRECTS;
  static ERR_BAD_RESPONSE: string = ErrorCodes.ERR_BAD_RESPONSE;
  static ERR_BAD_REQUEST: string = ErrorCodes.ERR_BAD_REQUEST;
  static ERR_CANCELED: string = ErrorCodes.ERR_CANCELED;
  static ERR_NOT_SUPPORT: string = ErrorCodes.ERR_NOT_SUPPORT;
  static ERR_INVALID_URL: string = ErrorCodes.ERR_INVALID_URL;
  static ERR_RATE_LIMIT_QUEUE_FULL: string = ErrorCodes.ERR_RATE_LIMIT_QUEUE_FULL;

  readonly code: string | null;
  private _config: CorriereRequestConfig | null;
  private _redactedConfig: CorriereRequestConfig | null = null;
  private _response: CorriereResponse | null;
  private _redactedResponse: CorriereResponse | null = null;
  readonly request: unknown;
  readonly isCorriereError: true;
  cause?: Error;
  override name = 'CorriereError' as const;

  get config(): CorriereRequestConfig | null {
    if (this._redactedConfig === null && this._config !== null) {
      this._redactedConfig = redactConfig(this._config);
    }
    return this._redactedConfig;
  }

  /**
   * The failing response, with its `config` redacted.
   *
   * `error.config` was already scrubbed, but `error.response.config` is the same caller
   * config the *successful* path deliberately leaves intact (see `finalizeResponse`), and
   * an error carries it straight into logs and crash reporters — so `console.error(err)`
   * printed the `Authorization` header in cleartext despite the getter above.
   *
   * Redacting here rather than at each construction site covers every path that builds an
   * error with a response: `settle`, `applySchema`, the adapter's read errors, and the
   * dedupe re-homing in `CorriereError.from`. Memoized so `error.response` keeps a stable
   * identity across reads and the scrub is paid for only if someone looks.
   */
  get response(): CorriereResponse | null {
    if (this._response === null) return null;
    if (this._redactedResponse === null) {
      this._redactedResponse = {
        ...this._response,
        config: redactConfig(this._response.config) as CorriereRequestConfig,
      };
    }
    return this._redactedResponse;
  }

  constructor(
    message: string,
    code: string | null,
    config: CorriereRequestConfig | null,
    request: unknown,
    response: CorriereResponse | null,
  ) {
    super(message);
    this.name = 'CorriereError';
    this.code = code ?? null;
    this._config = config ?? null;
    this.request = request ?? null;
    this._response = response ?? null;
    this.isCorriereError = true;

    if ((Error as any).captureStackTrace) {
      (Error as any).captureStackTrace(this, CorriereError);
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      status: this.response ? this.response.status : null,
      config: this.config,
    };
  }

  static from(
    error: Error,
    code: string,
    config: CorriereRequestConfig | null,
    request: unknown,
    response: CorriereResponse | null,
  ): CorriereError {
    const corriereError = new CorriereError(error.message, code, config, request, response);
    corriereError.cause = error;
    corriereError.stack = error.stack;
    return corriereError;
  }
}

export default CorriereError;
