import type { CorriereRequestConfig } from '../types';
import { defaultTransformRequest, defaultTransformResponse } from './transforms';

const defaults: CorriereRequestConfig = {
  method: 'get',
  timeout: 0,
  headers: {
    common: {
      Accept: 'application/json, text/plain, */*',
    },
    delete: {},
    get: {},
    head: {},
    options: {},
    post: {
      'Content-Type': 'application/json',
    },
    put: {
      'Content-Type': 'application/json',
    },
    patch: {
      'Content-Type': 'application/json',
    },
  },
  transformRequest: [defaultTransformRequest],
  transformResponse: [defaultTransformResponse],
  validateStatus: function defaultValidateStatus(status: number): boolean {
    return status >= 200 && status < 300;
  },
  responseType: 'json',
  withCredentials: false,
};

export default defaults;
