import { describe, expect, it, vi } from 'vitest';
import corriere from '../src/index';
import type { CorriereRequestConfig } from '../src/types';

function source(
  chunks: string[],
  config: CorriereRequestConfig = {},
  sse = false,
  keepOpen = false,
) {
  const cancel = vi.fn();
  const client = corriere.create({
    ...config,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            if (!keepOpen) controller.close();
          },
          cancel,
        }),
        { headers: { 'content-type': sse ? 'text/event-stream' : 'text/plain' } },
      ),
  });
  const collect = async () => {
    const values = [];
    for await (const value of client.stream('https://example.test')) values.push(value);
    return values;
  };
  return { collect, cancel };
}

describe('stream memory limits', () => {
  it('enforces the default event limit for individually valid lines', async () => {
    const line = `data: ${'x'.repeat(512 * 1024)}\n`;
    const stream = source(
      Array.from({ length: 17 }, () => line),
      {},
      true,
      true,
    );
    await expect(stream.collect()).rejects.toMatchObject({
      code: 'ERR_BAD_RESPONSE',
      message: expect.stringContaining('maxStreamEventBytes'),
    });
    expect(stream.cancel).toHaveBeenCalledTimes(1);
  });
  it('enforces the default line limit before an unterminated line can grow indefinitely', async () => {
    const stream = source(['x'.repeat(1024 * 1024 + 1)], {}, false, true);
    await expect(stream.collect()).rejects.toMatchObject({
      code: 'ERR_BAD_RESPONSE',
      message: expect.stringContaining('maxStreamLineBytes'),
    });
    expect(stream.cancel).toHaveBeenCalledTimes(1);
  });

  it('counts UTF-8 bytes across chunk boundaries and resets after each line', async () => {
    expect(await source(['é', 'é\n', 'éé\n'], { maxStreamLineBytes: 4 }).collect()).toEqual([
      'éé',
      'éé',
    ]);
    expect(await source(['😀\n'], { maxStreamLineBytes: 4 }).collect()).toEqual(['😀']);
    const stream = source(['é', 'é'], { maxStreamLineBytes: 3 }, false, true);
    await expect(stream.collect()).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE' });
    expect(stream.cancel).toHaveBeenCalledTimes(1);
  });

  it('limits multiline SSE events, including metadata, before joining payloads', async () => {
    const stream = source(
      ['data: a\r\n', 'data: b\r\n'],
      { maxStreamLineBytes: 20, maxStreamEventBytes: 15 },
      true,
      true,
    );
    await expect(stream.collect()).rejects.toMatchObject({
      code: 'ERR_BAD_RESPONSE',
      message: expect.stringContaining('maxStreamEventBytes'),
    });
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(
      await source(['data: a\r\n\r\ndata: b\n\n'], { maxStreamEventBytes: 8 }, true).collect(),
    ).toEqual(['a', 'b']);
    await expect(
      source([': comment\n: comment\n'], { maxStreamEventBytes: 10 }, true).collect(),
    ).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE' });
  });

  it('supports explicit opt-outs and zero-byte budgets', async () => {
    expect(
      await source(
        ['data: long payload\n\n'],
        { maxStreamLineBytes: Infinity, maxStreamEventBytes: Infinity },
        true,
      ).collect(),
    ).toEqual(['long payload']);
    await expect(source(['x\n'], { maxStreamLineBytes: 0 }).collect()).rejects.toMatchObject({
      code: 'ERR_BAD_RESPONSE',
    });
    expect(await source(['\n'], { maxStreamLineBytes: 0 }).collect()).toEqual([]);
  });

  it.each([-1, NaN, 0.5])('rejects invalid limits before transport: %s', async (limit) => {
    const fetch = vi.fn();
    const client = corriere.create({ fetch, maxStreamLineBytes: limit });
    await expect(
      (async () => {
        for await (const _ of client.stream('https://example.test')) {
          /* drain */
        }
      })(),
    ).rejects.toMatchObject({ code: 'ERR_BAD_OPTION_VALUE' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
