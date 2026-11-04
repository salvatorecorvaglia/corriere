import { afterEach, describe, expect, it, vi } from 'vitest';
import corriere from '../src/index';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function tracked(source: ReadableStream<Uint8Array>, maxContentLength?: number) {
  const abort = new AbortController();
  const remove = vi.spyOn(abort.signal, 'removeEventListener');
  const result = await corriere
    .create({ fetch: async () => new Response(source) })
    .get<ReadableStream<Uint8Array>>('https://example.test', {
      signal: abort.signal,
      timeout: 60_000,
      responseType: 'stream',
      maxContentLength,
    });
  return {
    body: result.data,
    released: () => remove.mock.calls.filter(([type]) => type === 'abort').length,
    abort,
  };
}

function finiteBytes() {
  return new ReadableStream<Uint8Array>({
    type: 'bytes',
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  });
}

describe('Web Stream lifecycle through native consumption paths', () => {
  it.each(['timeout', 'abort'] as const)(
    'releases unread-body abort wiring on %s exactly once',
    async (mode) => {
      vi.useFakeTimers();
      const stream = await tracked(new ReadableStream());
      expect(stream.released()).toBe(0);
      if (mode === 'timeout') await vi.advanceTimersByTimeAsync(60_000);
      else stream.abort.abort();
      expect(stream.released()).toBe(1);
      await stream.body.cancel();
      expect(stream.released()).toBe(1);
    },
  );
  it.each(['pipeTo', 'pipeThrough', 'tee'] as const)(
    'cleans up after %s drains the source',
    async (mode) => {
      const stream = await tracked(finiteBytes());
      const values: number[] = [];
      const sink = () =>
        new WritableStream<Uint8Array>({
          write(chunk) {
            values.push(...chunk);
          },
        });
      if (mode === 'pipeTo') await stream.body.pipeTo(sink());
      if (mode === 'pipeThrough')
        await stream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>()).pipeTo(sink());
      if (mode === 'tee') {
        const [first, second] = stream.body.tee();
        await Promise.all([first.pipeTo(sink()), second.pipeTo(new WritableStream())]);
      }
      expect(values).toEqual([1, 2, 3]);
      expect(stream.released()).toBe(1);
    },
  );

  it('cancels and releases the source when a destination fails', async () => {
    const failure = new Error('destination failed');
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array([1]));
      },
      cancel,
    });
    const stream = await tracked(source);
    await expect(
      stream.body.pipeTo(
        new WritableStream({
          write() {
            throw failure;
          },
        }),
      ),
    ).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledWith(failure);
    expect(source.locked).toBe(false);
    expect(stream.released()).toBe(1);
  });

  it('propagates source errors through piping and releases its lock', async () => {
    const failure = new Error('source failed');
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(failure);
      },
    });
    const stream = await tracked(source);
    await expect(stream.body.pipeTo(new WritableStream())).rejects.toBe(failure);
    expect(source.locked).toBe(false);
    expect(stream.released()).toBe(1);
  });

  it('keeps lifecycle wiring when cancellation fails because the body is locked', async () => {
    const stream = await tracked(new ReadableStream());
    const reader = stream.body.getReader();
    await expect(stream.body.cancel()).rejects.toThrow();
    expect(stream.released()).toBe(0);
    await reader.cancel();
    reader.releaseLock();
    expect(stream.released()).toBe(1);
  });

  it('keeps lifecycle wiring after iterator return with preventCancel', async () => {
    const stream = await tracked(
      new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array([1]));
        },
      }),
    );
    const iterator = stream.body.values({ preventCancel: true });
    await iterator.next();
    await iterator.return!();
    expect(stream.released()).toBe(0);
    await stream.body.cancel();
    expect(stream.released()).toBe(1);
  });

  it('waits for both tee branches to cancel before releasing the source', async () => {
    const cancel = vi.fn();
    const stream = await tracked(new ReadableStream({ cancel }));
    const [first, second] = stream.body.tee();
    const firstCancellation = first.cancel('first');
    expect(stream.released()).toBe(0);
    await Promise.all([firstCancellation, second.cancel('second')]);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.released()).toBe(1);
  });

  it.each([undefined, 10])(
    'preserves BYOB views and EOF with maxContentLength=%s',
    async (maxContentLength) => {
      const source = finiteBytes();
      const stream = await tracked(source, maxContentLength);
      const reader = stream.body.getReader({ mode: 'byob' });
      const first = await reader.read(new Uint8Array(8), { min: 2 });
      expect(Array.from(first.value!)).toEqual([1, 2, 3]);
      const last = await reader.read(new Uint8Array(8));
      expect(last.done).toBe(true);
      expect(last.value!.byteLength).toBe(0);
      reader.releaseLock();
      expect(source.locked).toBe(false);
      expect(stream.released()).toBe(1);
    },
  );

  it('preserves BYOB cancellation and does not patch the source or public reader methods', async () => {
    const source = new ReadableStream<Uint8Array>({ type: 'bytes' });
    const sourceGetReader = source.getReader;
    const stream = await tracked(source);
    expect(source.getReader).toBe(sourceGetReader);
    expect(Object.hasOwn(stream.body, 'getReader')).toBe(false);
    const reader = stream.body.getReader({ mode: 'byob' });
    expect(Object.hasOwn(reader, 'read')).toBe(false);
    const pending = reader.read(new Uint8Array(4));
    await reader.cancel();
    expect((await pending).done).toBe(true);
    reader.releaseLock();
    expect(source.locked).toBe(false);
    expect(stream.released()).toBe(1);
  });
});

describe('download observer failure cleanup', () => {
  it('delivers the observer error even while underlying cancellation remains pending', async () => {
    const failure = new Error('observer failed');
    let release!: () => void;
    const disposal = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array([1]));
      },
      cancel() {
        return disposal;
      },
    });
    const client = corriere.create({ fetch: async () => new Response(source) });
    const request = client.get('https://example.test', {
      onDownloadProgress() {
        throw failure;
      },
    });
    let outcome: unknown;
    request.catch((error) => {
      outcome = error;
    });
    try {
      await vi.waitFor(
        () => expect(outcome).toMatchObject({ code: 'ERR_BAD_RESPONSE', cause: failure }),
        { timeout: 250 },
      );
      expect(source.locked).toBe(false);
    } finally {
      release();
      await request.catch(() => {});
    }
  });

  it('cancels and unlocks the source, preserving a callback failure if cancellation also fails', async () => {
    const failure = new Error('observer failed');
    const cancel = vi.fn(() => {
      throw new Error('cancel failed');
    });
    const source = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array([1]));
      },
      cancel,
    });
    const client = corriere.create({ fetch: async () => new Response(source) });
    const error = await client
      .get('https://example.test', {
        onDownloadProgress() {
          throw failure;
        },
      })
      .catch((error) => error);
    expect(error.code).toBe('ERR_BAD_RESPONSE');
    expect(error.cause).toBe(failure);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(source.locked).toBe(false);
  });
});
