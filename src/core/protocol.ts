import { ERR_BAD_OPTION } from '../constants/errorCodes';
import type { CorriereRequestConfig } from '../types';
import CorriereError from './corriereError';

export const DEFAULT_ALLOWED_PROTOCOLS = ['http:', 'https:'];

/**
 * Rejects URLs whose scheme is not on the allow-list.
 *
 * Lives in its own module because both the request pipeline (pre-flight) and the fetch
 * adapter (once per redirect hop) need it, and `request.ts` already imports the adapter.
 */
export function assertAllowedProtocol(fullURL: string, config: CorriereRequestConfig): void {
  if (config.allowedProtocols === null) return;
  const allowed = config.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS;

  let scheme: string | null = null;
  let targetURL = fullURL;
  if (targetURL.startsWith('//')) {
    targetURL = `http:${targetURL}`;
  }
  const match = /^([a-z][a-z\d+\-.]*):/i.exec(targetURL);
  if (match) scheme = `${match[1].toLowerCase()}:`;
  if (!scheme) return;

  if (!allowed.includes(scheme)) {
    throw new CorriereError(
      `URL protocol "${scheme}" is not allowed. Allowed: ${allowed.join(', ')}. Set config.allowedProtocols to extend, or null to disable the check.`,
      ERR_BAD_OPTION,
      config,
      null,
      null,
    );
  }
}
