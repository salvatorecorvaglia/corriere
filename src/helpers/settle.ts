import CorriereError from '../core/corriereError';
import type { CorriereRequestConfig, CorriereResponse } from '../types';

export default function settle(
  resolve: (value: CorriereResponse) => void,
  reject: (reason: CorriereError) => void,
  response: CorriereResponse,
  config: CorriereRequestConfig,
): void {
  const validateStatus = config.validateStatus;

  if (!validateStatus || validateStatus(response.status)) {
    resolve(response);
  } else {
    const error = new CorriereError(
      `Request failed with status code ${response.status}`,
      response.status >= 400 && response.status < 500
        ? CorriereError.ERR_BAD_REQUEST
        : CorriereError.ERR_BAD_RESPONSE,
      config,
      response.request,
      response,
    );
    reject(error);
  }
}
