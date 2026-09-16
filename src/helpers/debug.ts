import type CorriereError from '../core/corriereError';
import { redactBody, redactParams, redactURL } from '../core/corriereError';
import type { CorriereRequestConfig, CorriereResponse } from '../types';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(1)} ${sizes[i]}`;
}

function sanitizeConfigForLog(config: CorriereRequestConfig): {
  params: Record<string, unknown> | undefined;
  timeout: number | undefined;
  retry: number | undefined;
} {
  return {
    params: config.params && (redactParams(config.params) as Record<string, unknown>),
    timeout: config.timeout,
    retry: config.retry,
  };
}

export function logRequest(config: CorriereRequestConfig, fullUrl: string): void {
  if (!config.debug) return;

  const safe = sanitizeConfigForLog(config);

  const method = (config.method || 'GET').toUpperCase();
  const url = redactURL(fullUrl || config.url || '') || '';

  const parts: string[] = [`🐦‍⬛ [Corriere] → ${method} ${url}`];

  if (safe.params && Object.keys(safe.params).length > 0) {
    try {
      parts.push(`   Params: ${JSON.stringify(safe.params)}`);
    } catch {
      parts.push('   Params: [unserializable params]');
    }
  }

  if (config.data && typeof config.data === 'object') {
    let preview: string;
    try {
      preview = JSON.stringify(redactBody(config.data));
    } catch {
      preview = '[unserializable body]';
    }
    const truncated = preview.length > 200 ? `${preview.substring(0, 200)}...` : preview;
    parts.push(`   Body: ${truncated}`);
  }

  if (safe.timeout) {
    parts.push(`   Timeout: ${safe.timeout}ms`);
  }

  if (safe.retry) {
    parts.push(`   Retry: ${safe.retry}x`);
  }

  console.log(parts.join('\n'));
}

export function logResponse(response: CorriereResponse): void {
  if (!response.config?.debug) return;
  const status = response.status;
  const statusText = response.statusText || '';
  const duration = response.duration != null ? `${response.duration}ms` : '??';

  const statusIcon = status >= 200 && status < 300 ? '✅' : status >= 400 ? '❌' : '⚠️';

  const parts: string[] = [`🐦‍⬛ [Corriere] ← ${statusIcon} ${status} ${statusText} (${duration})`];

  if (response.data) {
    try {
      const size =
        typeof response.data === 'string'
          ? response.data.length
          : JSON.stringify(response.data).length;
      parts.push(`   Size: ~${formatBytes(size)}`);
    } catch {
      // ignore
    }
  }

  console.log(parts.join('\n'));
}

export function logError(error: CorriereError, config?: CorriereRequestConfig): void {
  if (!config?.debug) return;

  const parts: string[] = [`🐦‍⬛ [Corriere] ← ❌ ERROR: ${error.message}`];

  if (error.code) {
    parts.push(`   Code: ${error.code}`);
  }

  if (error.response) {
    parts.push(`   Status: ${error.response.status}`);
  }

  console.log(parts.join('\n'));
}
