import type { CorriereRequestConfig } from '../types';

export function setBasicAuth(
  config: CorriereRequestConfig,
  headers: Record<string, string | string[]>,
): void {
  if (!config.auth) return;
  const username = config.auth.username || '';
  const password = config.auth.password || '';
  const credentials = `${username}:${password}`;

  let encoded: string;
  if (typeof Buffer !== 'undefined') {
    encoded = Buffer.from(credentials).toString('base64');
  } else {
    // Cryptic but effective UTF-8 to Base64 conversion for browsers lacking Buffer.
    // encodeURIComponent converts non-ASCII to %XX, then we replace %XX with raw bytes
    // before applying btoa.
    encoded = btoa(
      encodeURIComponent(credentials).replace(/%([0-9A-F]{2})/g, (_match, p1) => {
        return String.fromCharCode(Number.parseInt(p1, 16));
      }),
    );
  }
  const authKey =
    Object.keys(headers).find((key) => key.toLowerCase() === 'authorization') || 'Authorization';
  headers[authKey] = `Basic ${encoded}`;
}
