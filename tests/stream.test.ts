import { describe, expect, it, vi } from 'vitest';
import Corriere from '../src/corriere';

describe('Corriere streaming', () => {
  it('correctly processes SSE (Server-Sent Events) formatted stream', async () => {
    const encoder = new TextEncoder();
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"val": 1}\n'));
        controller.enqueue(encoder.encode('data: {"val": 2}\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n'));
        controller.close();
      },
    });

    const client = new Corriere();
    vi.spyOn(client, 'request').mockResolvedValue({
      data: mockStream,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
      request: {} as any,
      duration: 0,
    });

    const items: any[] = [];
    for await (const chunk of client.stream('/stream')) {
      items.push(chunk);
    }

    expect(items).toEqual([{ val: 1 }, { val: 2 }]);
  });

  it('correctly processes raw JSON lines', async () => {
    const encoder = new TextEncoder();
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"val": 3}\n{"val": 4}\n'));
        controller.close();
      },
    });

    const client = new Corriere();
    vi.spyOn(client, 'request').mockResolvedValue({
      data: mockStream,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
      request: {} as any,
      duration: 0,
    });

    const items: any[] = [];
    for await (const chunk of client.stream('/stream')) {
      items.push(chunk);
    }

    expect(items).toEqual([{ val: 3 }, { val: 4 }]);
  });

  it('handles partial text chunks correctly across reads', async () => {
    const encoder = new TextEncoder();
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"text": "he'));
        controller.enqueue(encoder.encode('llo"}\n'));
        controller.close();
      },
    });

    const client = new Corriere();
    vi.spyOn(client, 'request').mockResolvedValue({
      data: mockStream,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
      request: {} as any,
      duration: 0,
    });

    const items: any[] = [];
    for await (const chunk of client.stream('/stream')) {
      items.push(chunk);
    }

    expect(items).toEqual([{ text: 'hello' }]);
  });

  it('handles plain text data lines gracefully (non-JSON SSE)', async () => {
    const encoder = new TextEncoder();
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: hello world\n'));
        controller.close();
      },
    });

    const client = new Corriere();
    vi.spyOn(client, 'request').mockResolvedValue({
      data: mockStream,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
      request: {} as any,
      duration: 0,
    });

    const items: any[] = [];
    for await (const chunk of client.stream('/stream')) {
      items.push(chunk);
    }

    expect(items).toEqual(['hello world']);
  });

  it('handles empty response data gracefully', async () => {
    const client = new Corriere();
    vi.spyOn(client, 'request').mockResolvedValue({
      data: null as any,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
      request: {} as any,
      duration: 0,
    });

    const items: any[] = [];
    for await (const chunk of client.stream('/stream')) {
      items.push(chunk);
    }

    expect(items).toEqual([]);
  });

  it('correctly keeps abort event listener active during streaming and cleans up after completion', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();

    let streamController: ReadableStreamDefaultController | null = null;
    const mockStream = new ReadableStream({
      start(c) {
        streamController = c;
        c.enqueue(encoder.encode('data: {"val": 1}\n'));
      },
    });

    const client = new Corriere();
    const customSignal = controller.signal;

    // Spy on abort cleanup function or manually check event listeners
    let signalListenersCount = 0;
    const originalAddEventListener = customSignal.addEventListener.bind(customSignal);
    const originalRemoveEventListener = customSignal.removeEventListener.bind(customSignal);

    customSignal.addEventListener = vi.fn((type, listener, options) => {
      signalListenersCount++;
      return originalAddEventListener(type, listener, options);
    });
    customSignal.removeEventListener = vi.fn((type, listener, options) => {
      signalListenersCount--;
      return originalRemoveEventListener(type, listener, options);
    });

    const testAbortHandler = () => {
      try {
        streamController?.error(customSignal.reason || new Error('Aborted'));
      } catch {
        // ignore
      }
    };
    customSignal.addEventListener('abort', testAbortHandler);

    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: mockStream,
    });

    const streamGen = client.stream('/stream', { signal: customSignal, timeout: 5000 });
    const firstIter = await streamGen.next();
    expect(firstIter.value).toEqual({ val: 1 });

    // Assert that the listener is STILL active (has not been cleaned up yet because stream is open)
    expect(signalListenersCount).toBeGreaterThan(0);

    // Cancel / complete the stream by calling aborting
    controller.abort('user cancel');

    // Ensure the stream generator finishes and cleans up
    try {
      await streamGen.next();
    } catch (_e) {
      // ignore abort error if thrown
    }

    customSignal.removeEventListener('abort', testAbortHandler);

    // Verify cleanup was run
    expect(signalListenersCount).toBe(0);
  });

  it('handles a data: field whose multi-byte UTF-8 character is split across the chunk boundary', async () => {
    // "café" — the é is a 2-byte UTF-8 sequence (0xC3 0xA9). Splitting the encoded bytes
    // between the byte pair would corrupt the character unless the decoder is fed with
    // `{ stream: true }` and its byte buffer carried across `decoder.decode()` calls.
    const encoder = new TextEncoder();
    const fullBytes = encoder.encode('data: {"text": "café"}\n');
    // Split so the 0xC3 byte of "é" ends one chunk and 0xA9 starts the next.
    const splitIndex = fullBytes.indexOf(0xc3) + 1;
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(fullBytes.slice(0, splitIndex));
        controller.enqueue(fullBytes.slice(splitIndex));
        controller.close();
      },
    });

    const client = new Corriere();
    vi.spyOn(client, 'request').mockResolvedValue({
      data: mockStream,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
      request: {} as any,
      duration: 0,
    });

    const items: any[] = [];
    for await (const chunk of client.stream('/stream')) {
      items.push(chunk);
    }

    expect(items).toEqual([{ text: 'café' }]);
  });

  it('treats event:/id: lines as plain text when the response is not text/event-stream', async () => {
    // Without an SSE content type the body is read as line-delimited text, so these lines
    // are ordinary content. The SSE parser (below) applies only to text/event-stream.
    const encoder = new TextEncoder();
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: message\nid: 1\ndata: {"val": 1}\n'));
        controller.close();
      },
    });

    const client = new Corriere();
    vi.spyOn(client, 'request').mockResolvedValue({
      data: mockStream,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
      request: {} as any,
      duration: 0,
    });

    const items: any[] = [];
    for await (const chunk of client.stream('/stream')) {
      items.push(chunk);
    }

    expect(items).toEqual(['event: message', 'id: 1', { val: 1 }]);
  });
});

/**
 * `text/event-stream` bodies are parsed as Server-Sent Events. The parser used to yield
 * `event:`, `id:`, `retry:` and comment lines as if they were data, and yielded each line of
 * a multi-line `data:` field separately instead of as one event.
 */
describe('stream() with a text/event-stream response', () => {
  async function readSSE(chunks: string[]) {
    const encoder = new TextEncoder();
    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
        ),
      ),
    ) as any;
    const items: unknown[] = [];
    for await (const item of new Corriere().stream('https://api.test.com/sse')) items.push(item);
    return items;
  }

  it('yields only the data of each event, ignoring event/id/retry fields and comments', async () => {
    const items = await readSSE([
      ': keep-alive\n',
      'event: update\nid: 7\nretry: 1000\ndata: {"a":1}\n\n',
      'event: update\ndata: plain text\n\n',
    ]);
    expect(items).toEqual([{ a: 1 }, 'plain text']);
  });

  it('joins a multi-line data field into one event', async () => {
    const items = await readSSE([
      'data: {"a":\n',
      'data: 1}\n\n',
      'data: line one\ndata: line two\n\n',
    ]);
    expect(items).toEqual([{ a: 1 }, 'line one\nline two']);
  });

  it('dispatches on a blank line, even when it arrives in a later chunk', async () => {
    const items = await readSSE(['data: {"a"', ':1}\n', '\n', 'data: 2\n\n']);
    expect(items).toEqual([{ a: 1 }, 2]);
  });

  it('handles CRLF line endings and strips exactly one space after the colon', async () => {
    const items = await readSSE(['data:  padded\r\n\r\n', 'data:tight\r\n\r\n']);
    expect(items).toEqual([' padded', 'tight']);
  });

  it('skips the [DONE] sentinel and events with no data', async () => {
    const items = await readSSE(['event: ping\n\n', 'data: {"a":1}\n\n', 'data: [DONE]\n\n']);
    expect(items).toEqual([{ a: 1 }]);
  });

  it('flushes a final event that is not followed by a blank line', async () => {
    const items = await readSSE(['data: {"a":1}\n\n', 'data: {"b":2}']);
    expect(items).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('Node.js stream/async iterator support in stream()', () => {
  it('consumes stream using Symbol.asyncIterator if getReader is not present', async () => {
    const mockAsyncIterable = {
      async *[Symbol.asyncIterator]() {
        yield 'data: {"val": 10}\n';
        yield 'data: {"val": 20}\n';
      },
    };

    const client = new Corriere();
    vi.spyOn(client, 'request').mockResolvedValue({
      data: mockAsyncIterable,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
      request: {} as any,
      duration: 0,
    });

    const items: any[] = [];
    for await (const chunk of client.stream('/test')) {
      items.push(chunk);
    }

    expect(items).toEqual([{ val: 10 }, { val: 20 }]);
  });
});

describe('Robust SSE carriage return trimming', () => {
  it('trims carriage returns from line endings and parses properly', async () => {
    const mockStream = {
      async *[Symbol.asyncIterator]() {
        yield 'data: {"text": "hello"}\r\n';
        yield 'data: [DONE]\r\n';
      },
    };

    const client = new Corriere();
    vi.spyOn(client, 'request').mockResolvedValue({
      data: mockStream,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
      request: {} as any,
      duration: 0,
    });

    const items: any[] = [];
    for await (const chunk of client.stream('/test')) {
      items.push(chunk);
    }

    expect(items).toEqual([{ text: 'hello' }]);
  });
});

describe('Plain text streaming fallback support', () => {
  it('yields raw lines when stream contains non-SSE / non-JSON content', async () => {
    const client = new Corriere();
    const encoder = new TextEncoder();

    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('raw plain line 1\n'));
        controller.enqueue(encoder.encode('raw plain line 2\n'));
        controller.close();
      },
    });

    vi.spyOn(client, 'request').mockResolvedValue({
      data: mockStream,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
      request: {} as any,
      duration: 0,
    });

    const items: any[] = [];
    for await (const chunk of client.stream('/text-stream')) {
      items.push(chunk);
    }

    expect(items).toEqual(['raw plain line 1', 'raw plain line 2']);
  });
});

/**
 * With `cache: true` (typically set once on the instance) the stream object itself was
 * cached. The second `stream()` call replayed the already-drained stream and silently
 * yielded nothing.
 */
describe('stream() with caching enabled', () => {
  it('reads the body again on a second call instead of replaying a drained stream', async () => {
    let fetchCalls = 0;
    global.fetch = vi.fn(() => {
      fetchCalls++;
      return Promise.resolve(new Response('x\ny\n', { headers: { 'content-type': 'text/plain' } }));
    }) as any;

    const client = new Corriere({ cache: true });
    const read = async () => {
      const out: unknown[] = [];
      for await (const line of client.stream('https://api.test.com/feed')) out.push(line);
      return out;
    };

    expect(await read()).toEqual(['x', 'y']);
    expect(await read()).toEqual(['x', 'y']);
    expect(fetchCalls).toBe(2);
  });
});

describe('stream() with sseEvents: true', () => {
  async function readEvents(chunks: string[], contentType = 'text/event-stream') {
    global.fetch = vi.fn(() =>
      Promise.resolve(new Response(chunks.join(''), { headers: { 'content-type': contentType } })),
    ) as any;
    const items: unknown[] = [];
    for await (const item of new Corriere().stream('https://api.test.com/sse', {
      sseEvents: true,
    })) {
      items.push(item);
    }
    return items;
  }

  it('yields each event with its type, parsed data and id', async () => {
    const items = await readEvents(['event: update\nid: 1\ndata: {"a":1}\n\n', 'data: plain\n\n']);
    expect(items).toEqual([
      { event: 'update', data: { a: 1 }, id: '1' },
      // The type resets to 'message' after each event; the last id carries over, per spec.
      { event: 'message', data: 'plain', id: '1' },
    ]);
  });

  it('attaches a retry value to the next dispatched event, even when it arrived alone', async () => {
    const items = await readEvents(['retry: 3000\n\n', 'data: x\n\n', 'data: y\n\n']);
    expect(items).toEqual([
      { event: 'message', data: 'x', retry: 3000 },
      { event: 'message', data: 'y' },
    ]);
  });

  it('ignores a non-numeric retry and an id containing NUL', async () => {
    const items = await readEvents(['id: ok\n\n', 'retry: soon\nid: bad\u0000id\ndata: x\n\n']);
    expect(items).toEqual([{ event: 'message', data: 'x', id: 'ok' }]);
  });

  it('still skips comments, data-less events and [DONE]', async () => {
    const items = await readEvents([
      ': ping\n\n',
      'event: noop\n\n',
      'data: [DONE]\n\n',
      'data: 1\n\n',
    ]);
    expect(items).toEqual([{ event: 'message', data: 1 }]);
  });

  it('has no effect on a body that is not text/event-stream', async () => {
    const items = await readEvents(['{"a":1}\n', 'event: x\n'], 'application/x-ndjson');
    expect(items).toEqual([{ a: 1 }, 'event: x']);
  });
});
