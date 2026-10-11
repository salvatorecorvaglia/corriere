import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import Corriere from '../src/corriere';

/**
 * A `responseType: 'stream'` response keeps its timeout timer and the listener on the
 * caller's signal alive until the body is finished with — the fetch has returned, but the
 * download has not. These tests pin down that every way of finishing with the body
 * releases them: reading to the end, stopping early, an error, and, for a Node stream,
 * its `end`/`close`/`error` events.
 *
 * The release is observed as the listener being removed from the caller's signal.
 */
function watchedSignal() {
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const released = () => remove.mock.calls.some(([type]) => type === 'abort');
  return { signal: controller.signal, released };
}

function serveBody(body: BodyInit | ReadableStream | Readable) {
  global.fetch = vi.fn(() =>
    Promise.resolve(
      body instanceof Readable
        ? // A Node stream is not a valid web Response body, so hand one back the way a
          // Node-flavoured fetch implementation would: a response-like object.
          ({ status: 200, statusText: 'OK', headers: new Headers(), body } as any)
        : new Response(body as BodyInit, { headers: { 'content-type': 'text/plain' } }),
    ),
  ) as any;
}

async function getStream(signal: AbortSignal) {
  const res = await new Corriere().get('https://api.test.com/s', {
    responseType: 'stream',
    timeout: 60_000,
    signal,
  });
  return res.data as any;
}

describe('stream response cleanup', () => {
  it('is not released while the body is still unread', async () => {
    serveBody('a\nb\n');
    const { signal, released } = watchedSignal();
    await getStream(signal);
    expect(released()).toBe(false);
  });

  it('is released when the body is read to the end with for await', async () => {
    serveBody('a\nb\n');
    const { signal, released } = watchedSignal();
    const body = await getStream(signal);
    for await (const _ of body) {
      // drain
    }
    expect(released()).toBe(true);
  });

  it('is released when for await stops early', async () => {
    serveBody(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('chunk'));
        },
      }),
    );
    const { signal, released } = watchedSignal();
    const body = await getStream(signal);
    for await (const _ of body) {
      break;
    }
    expect(released()).toBe(true);
  });

  it('is released when reading the body fails', async () => {
    serveBody(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error('connection reset'));
        },
      }),
    );
    const { signal, released } = watchedSignal();
    const body = await getStream(signal);
    await expect(
      (async () => {
        for await (const _ of body) {
          // drain
        }
      })(),
    ).rejects.toThrow('connection reset');
    expect(released()).toBe(true);
  });

  it('is released when a reader is cancelled', async () => {
    serveBody('a\nb\n');
    const { signal, released } = watchedSignal();
    const body = await getStream(signal);
    await body.getReader().cancel();
    expect(released()).toBe(true);
  });

  describe('with a Node stream body', () => {
    it('is released when the stream ends', async () => {
      const node = Readable.from(['a', 'b']);
      serveBody(node);
      const { signal, released } = watchedSignal();
      const body = await getStream(signal);
      body.resume();
      await new Promise((resolve) => body.on('end', resolve));
      expect(released()).toBe(true);
    });

    it('is released when the stream is destroyed with an error', async () => {
      const node = new Readable({ read() {} });
      serveBody(node);
      const { signal, released } = watchedSignal();
      const body = await getStream(signal);
      body.on('error', () => {});
      body.destroy(new Error('boom'));
      await new Promise((resolve) => body.on('close', resolve));
      expect(released()).toBe(true);
    });

    it('is released when its async iterator is thrown into', async () => {
      const node = Readable.from(['a', 'b']);
      serveBody(node);
      const { signal, released } = watchedSignal();
      const body = await getStream(signal);
      const iterator = body[Symbol.asyncIterator]();
      await iterator.throw(new Error('stop')).catch(() => {});
      expect(released()).toBe(true);
    });
  });
});
