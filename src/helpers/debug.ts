import type CorriereError from '../core/corriereError';
import { redactURL } from '../core/corriereError';
import type { CorriereRequestConfig, CorriereResponse } from '../types';
import { debugPreview } from './debugPreview';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(1)} ${sizes[i]}`;
}

export function logRequest(config: CorriereRequestConfig, fullUrl: string): void {
  if (!config.debug) return;

  const method = (config.method || 'GET').slice(0, 32).toUpperCase();
  const url = (redactURL(fullUrl || config.url || '') || '').slice(0, 2048);

  const parts: string[] = [`🔔 [Corriere] → ${method} ${url}`];

  if (config.params) parts.push(`   Params: ${debugPreview(config.params)}`);

  if (config.data && typeof config.data === 'object') {
    parts.push(`   Body: ${debugPreview(config.data)}`);
  }

  if (config.timeout) {
    parts.push(`   Timeout: ${config.timeout}ms`);
  }

  if (config.retry) {
    parts.push(`   Retry: ${config.retry}x`);
  }

  console.log(parts.join('\n'));
}

export function logResponse(response: CorriereResponse): void {
  if (!response.config?.debug) return;
  const status = response.status;
  const statusText = (response.statusText || '').slice(0, 256);
  const duration = response.duration != null ? `${response.duration}ms` : '??';

  const statusIcon = status >= 200 && status < 300 ? '✅' : status >= 400 ? '❌' : '⚠️';

  const parts: string[] = [`🔔 [Corriere] ← ${statusIcon} ${status} ${statusText} (${duration})`];

  // Do not serialize arbitrary payloads merely to estimate their size.
  const lengthHeader = response.headers?.['content-length'];
  const declared = Number(Array.isArray(lengthHeader) ? lengthHeader[0] : lengthHeader);
  if (lengthHeader !== undefined && Number.isFinite(declared) && declared >= 0) {
    parts.push(`   Size: ~${formatBytes(declared)}`);
  } else if (typeof response.data === 'string') {
    parts.push(`   Size: ~${formatBytes(response.data.length)}`);
  } else if (response.data) {
    parts.push('   Size: [not measured]');
  }

  console.log(parts.join('\n'));
}

export function logError(error: CorriereError, config?: CorriereRequestConfig): void {
  if (!config?.debug) return;

  const parts: string[] = [`🔔 [Corriere] ← ❌ ERROR: ${error.message.slice(0, 2048)}`];

  if (error.code) {
    parts.push(`   Code: ${error.code.slice(0, 128)}`);
  }

  if (error.response) {
    parts.push(`   Status: ${error.response.status}`);
  }

  console.log(parts.join('\n'));
}
