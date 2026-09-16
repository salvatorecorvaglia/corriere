import { describe, expect, it } from 'vitest';
import CorriereError, { redactConfig } from '../src/core/corriereError';

describe('CorriereError', () => {
  it('creates an error with all properties', () => {
    const config = { url: '/test', method: 'get' };
    const response = {
      status: 404,
      data: 'Not Found',
      headers: {},
      config,
      request: {} as any,
      duration: 0,
      statusText: '',
    } as any;
    const error = new CorriereError('Not found', 'ERR_BAD_REQUEST', config, null, response);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CorriereError);
    expect(error.name).toBe('CorriereError');
    expect(error.message).toBe('Not found');
    expect(error.code).toBe('ERR_BAD_REQUEST');
    expect(error.config).toEqual(config);
    expect(error.config).not.toBe(config);
    expect(error.request).toBeNull();
    // A redacted view, so equal in payload but deliberately not the same object.
    expect(error.response).not.toBe(response);
    expect(error.response?.status).toBe(response.status);
    expect(error.response?.data).toBe(response.data);
    expect(error.isCorriereError).toBe(true);
  });

  it('defaults optional parameters to null', () => {
    const error = new CorriereError('fail', null, null, null, null);
    expect(error.code).toBeNull();
    expect(error.config).toBeNull();
    expect(error.request).toBeNull();
    expect(error.response).toBeNull();
  });

  it('has a stack trace', () => {
    const error = new CorriereError('test', '', null, null, null);
    expect(error.stack).toBeDefined();
    expect(typeof error.stack).toBe('string');
  });

  describe('toJSON', () => {
    it('returns a serializable object', () => {
      const config = { url: '/test' };
      const response = {
        status: 500,
        data: null,
        headers: {},
        config,
        request: {} as any,
        duration: 0,
        statusText: '',
      } as any;
      const error = new CorriereError('Server error', 'ERR_BAD_RESPONSE', config, null, response);
      const json = error.toJSON();

      expect(json.name).toBe('CorriereError');
      expect(json.message).toBe('Server error');
      expect(json.code).toBe('ERR_BAD_RESPONSE');
      expect(json.status).toBe(500);
      expect(json.config).toEqual(config);
    });

    it('returns null status when no response', () => {
      const error = new CorriereError('Network error', 'ERR_NETWORK', null, null, null);
      expect(error.toJSON().status).toBeNull();
    });
  });

  describe('from', () => {
    it('creates a CorriereError from a regular Error', () => {
      const original = new Error('original message');
      const corriereError = CorriereError.from(
        original,
        'ERR_NETWORK',
        { url: '/test' },
        null,
        null,
      );

      expect(corriereError).toBeInstanceOf(CorriereError);
      expect(corriereError.message).toBe('original message');
      expect(corriereError.code).toBe('ERR_NETWORK');
      expect(corriereError.cause).toBe(original);
      expect(corriereError.stack).toBe(original.stack);
    });
  });

  describe('error code constants', () => {
    it('has all expected error codes', () => {
      expect(CorriereError.ERR_BAD_OPTION_VALUE).toBe('ERR_BAD_OPTION_VALUE');
      expect(CorriereError.ERR_BAD_OPTION).toBe('ERR_BAD_OPTION');
      expect(CorriereError.ECONNABORTED).toBe('ECONNABORTED');
      expect(CorriereError.ETIMEDOUT).toBe('ETIMEDOUT');
      expect(CorriereError.ERR_NETWORK).toBe('ERR_NETWORK');
      expect(CorriereError.ERR_BAD_RESPONSE).toBe('ERR_BAD_RESPONSE');
      expect(CorriereError.ERR_BAD_REQUEST).toBe('ERR_BAD_REQUEST');
      expect(CorriereError.ERR_CANCELED).toBe('ERR_CANCELED');
      expect(CorriereError.ERR_NOT_SUPPORT).toBe('ERR_NOT_SUPPORT');
      expect(CorriereError.ERR_INVALID_URL).toBe('ERR_INVALID_URL');
    });
  });

  describe('credential redaction', () => {
    it('strips auth from error.config', () => {
      const err = new CorriereError(
        'boom',
        CorriereError.ERR_BAD_REQUEST,
        { url: '/x', auth: { username: 'u', password: 'p' } } as any,
        null,
        null,
      );
      expect((err.config as any).auth).toBeUndefined();
      expect(err.config?.url).toBe('/x');
    });

    it('redacts Authorization header (any casing) in error.config', () => {
      const err = new CorriereError(
        'boom',
        CorriereError.ERR_BAD_REQUEST,
        {
          url: '/x',
          headers: { Authorization: 'Bearer s3cret', 'content-type': 'application/json' },
        } as any,
        null,
        null,
      );
      expect((err.config as any).headers.Authorization).toBe('[REDACTED]');
      expect((err.config as any).headers['content-type']).toBe('application/json');
    });

    it('does not mutate the original config', () => {
      const original = {
        url: '/x',
        auth: { username: 'u', password: 'p' },
        headers: { authorization: 'Bearer s' },
      } as any;
      new CorriereError('boom', CorriereError.ERR_BAD_REQUEST, original, null, null);
      expect(original.auth).toEqual({ username: 'u', password: 'p' });
      expect(original.headers.authorization).toBe('Bearer s');
    });

    it('does not falsely flag a shared (non-circular) nested reference as [Circular]', () => {
      const shared = { x: 1 };
      const err = new CorriereError(
        'boom',
        CorriereError.ERR_BAD_REQUEST,
        { url: '/x', data: { a: shared, b: shared } } as any,
        null,
        null,
      );
      expect((err.config as any).data).toEqual({ a: { x: 1 }, b: { x: 1 } });
    });

    it('still redacts a genuine circular reference as [Circular]', () => {
      const circular: any = { name: 'x' };
      circular.self = circular;
      const err = new CorriereError(
        'boom',
        CorriereError.ERR_BAD_REQUEST,
        { url: '/x', data: circular } as any,
        null,
        null,
      );
      expect((err.config as any).data).toEqual({ name: 'x', self: '[Circular]' });
    });

    it('does not throw when a query key has malformed percent-encoding', () => {
      const err = new CorriereError(
        'boom',
        CorriereError.ERR_NETWORK,
        { url: 'https://example.com/path?%zz=1&token=abc' } as any,
        null,
        null,
      );
      expect(() => err.config).not.toThrow();
      expect(() => JSON.stringify(err)).not.toThrow();
      expect(err.config?.url).toContain('token=[REDACTED]');
    });
  });
});

describe('redaction in CorriereError', () => {
  it('redacts sensitive query params in error config', () => {
    const config = {
      url: '/test',
      params: {
        username: 'user',
        password: 'secret_password',
        api_key: 'secret_key',
        token: 'secret_token',
        safe: 'public_value',
      },
    };

    const error = new CorriereError('fail', 'ERR_FAIL', config, null, null);

    expect(error.config?.params).toEqual({
      username: 'user',
      password: '[REDACTED]',
      api_key: '[REDACTED]',
      token: '[REDACTED]',
      safe: 'public_value',
    });
  });

  it('redacts inline credentials in URLs', () => {
    const config1 = { url: 'https://user:password@api.example.com/v1/resource' };
    const error1 = new CorriereError('fail', 'ERR_FAIL', config1, null, null);
    expect(error1.config?.url).toBe('https://user:[REDACTED]@api.example.com/v1/resource');

    const config2 = { url: 'http://token@api.example.com/v1/resource' };
    const error2 = new CorriereError('fail', 'ERR_FAIL', config2, null, null);
    expect(error2.config?.url).toBe('http://[REDACTED]@api.example.com/v1/resource');
  });
});

describe('Circular reference handling in config log/redact', () => {
  it('redacts config with circular headers/params without crashing', async () => {
    const { redactConfig } = await import('../src/core/corriereError');
    const circular: any = { key: 'val' };
    circular.self = circular;

    const config = {
      url: '/test',
      headers: {
        'x-circular': circular,
      },
      params: {
        circularParam: circular,
      },
    };

    const redacted = redactConfig(config);
    expect(redacted).toBeDefined();
    expect(redacted?.headers?.['x-circular']).toEqual({ key: 'val', self: '[Circular]' });
    expect(redacted?.params?.circularParam).toEqual({ key: 'val', self: '[Circular]' });
  });

  it('redacts large objects and arrays correctly', async () => {
    const { redactBody } = await import('../src/core/corriereError');
    const largeArray = new Array(200).fill('item');
    const largeObject: any = {};
    for (let i = 0; i < 200; i++) {
      largeObject[`key_${i}`] = 'value';
    }

    const redactedArray = redactBody(largeArray) as any[];
    expect(redactedArray.length).toBe(101);
    expect(redactedArray[100]).toContain('truncated');

    const redactedObj = redactBody(largeObject) as Record<string, any>;
    expect(Object.keys(redactedObj).length).toBe(101);
    expect(redactedObj['...']).toContain('Truncated');
  });
});

describe('redactURL', () => {
  it('redacts sensitive query parameters', () => {
    const config = {
      url: 'https://example.com/api?api_key=secret-token&password=123&other=public',
    };
    const redacted = redactConfig(config);
    expect(redacted?.url).toBe(
      'https://example.com/api?api_key=[REDACTED]&password=[REDACTED]&other=public',
    );
  });
});

describe('redactHeaders redacts x-api-key, api-key, and proxy-authorization headers', () => {
  it('redactHeaders redacts x-api-key, api-key, and proxy-authorization headers', () => {
    const err = new CorriereError(
      'Test',
      'ERR_TEST',
      {
        headers: {
          'x-api-key': 'secret-key-123',
          'api-key': 'secret-key-456',
          'proxy-authorization': 'Basic secret-auth',
        },
      },
      null,
      null,
    );
    expect(err.config?.headers).toEqual({
      'x-api-key': '[REDACTED]',
      'api-key': '[REDACTED]',
      'proxy-authorization': '[REDACTED]',
    });
  });
});
