import { describe, expect, it } from 'vitest';

describe('setBasicAuth browser fallback when Buffer is undefined', () => {
  it('uses btoa for credentials encoding', async () => {
    const { setBasicAuth } = await import('../src/helpers/auth');
    const originalBuffer = (global as any).Buffer;
    try {
      (global as any).Buffer = undefined;
      const config = {
        auth: {
          username: 'user',
          password: 'password',
        },
      };
      const headers: any = {};
      setBasicAuth(config, headers);
      expect(headers.Authorization).toBe('Basic dXNlcjpwYXNzd29yZA==');
    } finally {
      (global as any).Buffer = originalBuffer;
    }
  });
});
