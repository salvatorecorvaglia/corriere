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

  it('treats interleaved SSE event:/id: fields as plain text lines, not as part of data:', async () => {
    // The parser has no special handling for `event:`/`id:` fields — it only recognizes
    // `data:`-prefixed lines and bare JSON lines. This pins down that documented behavior:
    // non-`data:` fields are yielded as their own (trimmed) string chunks rather than being
    // attached to the `data:` payload or silently dropped.
    const encoder = new TextEncoder();
    const mockStream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('event: message\nid: 1\ndata: {"val": 1}\n\ndata: {"val": 2}\n'),
        );
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

    expect(items).toEqual(['event: message', 'id: 1', { val: 1 }, { val: 2 }]);
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
