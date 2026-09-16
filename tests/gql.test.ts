import { describe, expect, it, vi } from 'vitest';
import Corriere from '../src/corriere';

describe('Corriere gql', () => {
  it('makes a POST request with query and variables', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => Promise.resolve('{"data": {"user": {"name": "Bob"}}}'),
    });
    global.fetch = mockFetch;

    const client = new Corriere();
    const response = await client.gql('/graphql', 'query getUser { user { name } }', { id: '123' });

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ data: { user: { name: 'Bob' } } });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/graphql'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          query: 'query getUser { user { name } }',
          variables: { id: '123' },
        }),
      }),
    );
  });
});
