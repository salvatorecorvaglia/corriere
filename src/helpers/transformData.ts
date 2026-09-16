import CorriereError from '../core/corriereError';
import type { CorriereRequestConfig, TransformFunction } from '../types';

export default async function transformData(
  transforms: TransformFunction | TransformFunction[] | undefined,
  data: unknown,
  headers: Record<string, string | string[]>,
  config?: CorriereRequestConfig,
  direction: 'request' | 'response' = 'request',
): Promise<unknown> {
  if (!transforms) {
    return data;
  }

  const transformList = Array.isArray(transforms) ? transforms : [transforms];

  let result = data;

  for (const transform of transformList) {
    if (typeof transform === 'function') {
      try {
        result = await transform(result, headers, config);
      } catch (err) {
        throw CorriereError.from(
          err instanceof Error ? err : new Error(String(err)),
          direction === 'response' ? CorriereError.ERR_BAD_RESPONSE : CorriereError.ERR_BAD_REQUEST,
          config ?? null,
          null,
          null,
        );
      }
    }
  }

  return result;
}
