import { describe, expect, it } from 'vitest';
import Corriere from '../src/corriere';

describe('assertAllowedProtocol', () => {
  it('blocks protocol-relative URLs when not in allowedProtocols', async () => {
    const client = new Corriere({ allowedProtocols: ['https:'] });
    await expect(client.get('//malicious-domain.com/api')).rejects.toThrow(
      /URL protocol "http:" is not allowed/,
    );
  });
});
