import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { readStreamBody } from '../src/features/stream';
import type { CorriereResponse } from '../src/types';

async function collect(chunks: Uint8Array[], events = false, node = false) {
  const body = node
    ? Readable.from(chunks)
    : new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
  const response: CorriereResponse = {
    data: body,
    headers: { 'content-type': 'text/event-stream' },
    config: { sseEvents: events },
    status: 200,
    statusText: '',
    duration: 0,
    request: new Response(null),
  };
  const values = [];
  for await (const item of readStreamBody(response)) values.push(item);
  return values;
}

describe('SSE line terminators', () => {
  it.each(['\r', '\n', '\r\n'])('parses events terminated by %j', async (ending) => {
    const bytes = new TextEncoder().encode(`data: 1${ending}${ending}data: 2${ending}${ending}`);
    expect(await collect([bytes])).toEqual([1, 2]);
  });

  it.each([false, true])(
    'handles every byte split, mixed terminators, and UTF-8 (Node stream: %s)',
    async (node) => {
      const bytes = new TextEncoder().encode(
        'id: x\r\nevent: update\rdata: café\ndata: two\r\ndata: three\r\n\r\ndata: 2\n\n',
      );
      const expected = [
        { event: 'update', id: 'x', data: 'café\ntwo\nthree' },
        { event: 'message', id: 'x', data: 2 },
      ];
      for (let split = 0; split <= bytes.length; split++) {
        expect(await collect([bytes.slice(0, split), bytes.slice(split)], true, node)).toEqual(
          expected,
        );
      }
      expect(
        await collect(
          Array.from(bytes, (byte) => new Uint8Array([byte])),
          true,
          node,
        ),
      ).toEqual(expected);
    },
  );

  it('dispatches a CR-terminated event without waiting for the next network chunk', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: 1\r\r'));
      },
      cancel,
    });
    const response: CorriereResponse = {
      data: body,
      headers: { 'content-type': 'text/event-stream' },
      config: {},
      status: 200,
      statusText: '',
      duration: 0,
      request: new Response(null),
    };
    const iterator = readStreamBody(response);
    expect(await iterator.next()).toEqual({ done: false, value: 1 });
    await iterator.return();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('preserves the final-event leniency after a trailing CR or incomplete UTF-8', async () => {
    expect(await collect([new TextEncoder().encode('data: final\r')])).toEqual(['final']);
    const prefix = new TextEncoder().encode('data: ');
    expect(await collect([prefix, new Uint8Array([0xc3])])).toEqual(['�']);
  });
});
