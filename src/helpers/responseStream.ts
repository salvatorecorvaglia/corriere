/**
 * Observe completion at the underlying-source boundary, so native readers, pipes,
 * iterators and tee branches all use the same lifecycle without patched methods.
 */
export function wrapReadableStream(
  source: ReadableStream<Uint8Array>,
  cleanup: () => void,
  onChunk?: (chunk: Uint8Array) => void,
): ReadableStream<Uint8Array> {
  let bytes = false;
  try {
    const probe = source.getReader({ mode: 'byob' });
    probe.releaseLock();
    bytes = true;
  } catch {
    // Default streams need not support BYOB. Acquiring their default reader below
    // still reports a locked or invalid source rather than hiding that failure.
  }
  const reader = source.getReader();
  let finished = false;
  function release(): void {
    try {
      reader.releaseLock();
    } finally {
      cleanup();
    }
  }

  const pull = async (
    controller: ReadableStreamDefaultController<Uint8Array> | ReadableByteStreamController,
  ): Promise<void> => {
    try {
      const { done, value } = await reader.read();
      // A concurrent cancel owns completion and may have resolved this pending read.
      if (finished) return;
      if (done) {
        controller.close();
        // Closing an empty byte stream must also settle any outstanding BYOB read.
        if ('byobRequest' in controller) controller.byobRequest?.respond(0);
        finished = true;
        release();
        return;
      }
      onChunk?.(value);
      if ('byobRequest' in controller) {
        // Byte controllers transfer their buffers and cannot accept shared backing
        // memory. Reuse an ArrayBuffer without copying; copy shared memory if needed.
        const chunk =
          value.buffer instanceof ArrayBuffer
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : new Uint8Array(value);
        controller.enqueue(chunk);
      } else {
        controller.enqueue(value);
      }
    } catch (error) {
      if (finished) return;
      finished = true;
      try {
        // Start disposal, but a broken source whose cancel promise never settles
        // must not strand delivery of the original source/observer error.
        reader.cancel(error).catch(() => {});
      } catch {
        // A source or observer failure takes precedence over a cancellation failure.
      } finally {
        release();
      }
      controller.error(error);
    }
  };
  const cancel = async (reason: unknown): Promise<void> => {
    finished = true;
    try {
      await reader.cancel(reason);
    } finally {
      release();
    }
  };

  // Demand-driven reads preserve backpressure; byte sources remain BYOB-capable.
  return bytes
    ? new ReadableStream({ type: 'bytes', pull, cancel }, { highWaterMark: 0 })
    : new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
}
