import { describe, expect, it } from 'vitest';
import settle from '../src/helpers/settle';

describe('settle', () => {
  it('resolves when validateStatus returns true', () => {
    const response = {
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
      request: {},
      duration: 0,
    };
    const config = { validateStatus: (s: number) => s >= 200 && s < 300 };

    return new Promise((resolve, reject) => {
      settle(resolve as any, reject, response as any, config as any);
    }).then((res: any) => {
      expect(res).toBe(response);
    });
  });

  it('rejects with CorriereError when validateStatus returns false', () => {
    const response = {
      status: 404,
      statusText: 'Not Found',
      request: {},
      headers: {},
      config: {},
      duration: 0,
    };
    const config = { validateStatus: (s: number) => s >= 200 && s < 300 };

    return new Promise((resolve, reject) => {
      settle(resolve as any, reject, response as any, config as any);
    }).catch((error: any) => {
      expect(error.isCorriereError).toBe(true);
      expect(error.message).toContain('404');
      // `error.response` is a redacted *view* of the response, not the same object.
      expect(error.response).toEqual({ ...response, config: error.response.config });
      expect(error.response.status).toBe(response.status);
    });
  });

  it('uses ERR_BAD_REQUEST for 4xx status', () => {
    const response = {
      status: 400,
      request: {},
      headers: {},
      config: {},
      duration: 0,
      statusText: '',
    };
    const config = { validateStatus: () => false };

    return new Promise((resolve, reject) => {
      settle(resolve as any, reject, response as any, config as any);
    }).catch((error: any) => {
      expect(error.code).toBe('ERR_BAD_REQUEST');
    });
  });

  it('uses ERR_BAD_RESPONSE for 5xx status', () => {
    const response = {
      status: 500,
      request: {},
      headers: {},
      config: {},
      duration: 0,
      statusText: '',
    };
    const config = { validateStatus: () => false };

    return new Promise((resolve, reject) => {
      settle(resolve as any, reject, response as any, config as any);
    }).catch((error: any) => {
      expect(error.code).toBe('ERR_BAD_RESPONSE');
    });
  });

  it('resolves when no validateStatus is provided', () => {
    const response = {
      status: 500,
      headers: {},
      config: {},
      request: {},
      duration: 0,
      statusText: '',
    };
    const config = {};

    return new Promise((resolve, reject) => {
      settle(resolve as any, reject, response as any, config as any);
    }).then((res: any) => {
      expect(res).toBe(response);
    });
  });

  it('rejects when status is 0 and validateStatus rejects it (M4)', () => {
    const response = {
      status: 0,
      headers: {},
      config: {},
      request: {},
      duration: 0,
      statusText: '',
    };
    const config = { validateStatus: (s: number) => s >= 200 && s < 300 };

    return new Promise((resolve, reject) => {
      settle(resolve as any, reject, response as any, config as any);
    }).then(
      () => {
        throw new Error('expected rejection');
      },
      (error: any) => {
        expect(error.isCorriereError).toBe(true);
        // `error.response` is a redacted *view* of the response, not the same object.
        expect(error.response).toEqual({ ...response, config: error.response.config });
        expect(error.response.status).toBe(response.status);
      },
    );
  });

  it('still resolves status=0 when no validateStatus is configured', () => {
    const response = {
      status: 0,
      headers: {},
      config: {},
      request: {},
      duration: 0,
      statusText: '',
    };
    return new Promise((resolve, reject) => {
      settle(resolve as any, reject, response as any, {} as any);
    }).then((res: any) => {
      expect(res).toBe(response);
    });
  });
});
