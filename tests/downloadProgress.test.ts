import { describe, expect, it, vi } from 'vitest';
import dispatchRequest from '../src/core/request';

function bodyOf(chunks: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index++]));
    },
  });
}

function serve(chunks: string[], headers: Record<string, string> = {}) {
  global.fetch = vi.fn(
    () =>
      Promise.resolve(
        new Response(bodyOf(chunks), {
          status: 200,
          headers: { 'content-type': 'application/json', ...headers },
        }),
      ) as any,
  ) as any;
}

describe('onDownloadProgress', () => {
  it('reports cumulative loaded bytes and the content-length total', async () => {
    const chunks = ['{"a":', '1,"b":', '2}'];
    const totalBytes = chunks.join('').length;
    serve(chunks, { 'content-length': String(totalBytes) });

    const events: Array<{ loaded: number; total: number }> = [];
    await dispatchRequest({
      url: 'https://api.test.com/progress',
      method: 'get',
      onDownloadProgress: (e) => events.push({ ...e }),
    });

    expect(events.length).toBe(chunks.length);
    expect(events.every((e) => e.total === totalBytes)).toBe(true);
    // loaded must be monotonically increasing and end at the full size
    expect(events.map((e) => e.loaded)).toEqual([5, 11, 13]);
    expect(events.at(-1)!.loaded).toBe(totalBytes);
  });

  it('reports total 0 when the server sends no content-length', async () => {
    serve(['{"ok":true}']);
    const events: Array<{ loaded: number; total: number }> = [];
    await dispatchRequest({
      url: 'https://api.test.com/progress',
      method: 'get',
      onDownloadProgress: (e) => events.push({ ...e }),
    });
    expect(events).toHaveLength(1);
    expect(events[0].total).toBe(0);
    expect(events[0].loaded).toBeGreaterThan(0);
  });

  it('is not invoked for responseType: stream', async () => {
    serve(['a', 'b']);
    const onDownloadProgress = vi.fn();
    const res = await dispatchRequest({
      url: 'https://api.test.com/progress',
      method: 'get',
      responseType: 'stream',
      onDownloadProgress,
    });
    // Drain so the stream completes.
    const reader = (res.data as ReadableStream).getReader();
    while (!(await reader.read()).done) {
      /* drain */
    }
    expect(onDownloadProgress).not.toHaveBeenCalled();
  });

  it('parses the delivered body correctly through the progress wrapper', async () => {
    serve(['{"a":', '1}'], { 'content-length': '7' });
    const res = await dispatchRequest({
      url: 'https://api.test.com/progress',
      method: 'get',
      onDownloadProgress: () => {},
    });
    expect(res.data).toEqual({ a: 1 });
  });
});

describe('stream backpressure', () => {
  it('does not drain the source eagerly when the consumer is slow', async () => {
    const encoder = new TextEncoder();
    let produced = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced++;
        if (produced > 20) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`chunk-${produced}`));
      },
    });

    global.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(source, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
      ),
    ) as any;

    const res = await dispatchRequest({
      url: 'https://api.test.com/big',
      method: 'get',
      responseType: 'stream',
      maxContentLength: 10_000,
    });

    const reader = (res.data as ReadableStream).getReader();
    await reader.read(); // pull exactly one chunk

    // A start()-driven wrapper would have drained all 20 chunks by now. A pull()-driven
    // one reads only what the consumer asked for (plus at most a small ready-queue).
    expect(produced).toBeLessThan(20);

    await reader.cancel();
  });
});
