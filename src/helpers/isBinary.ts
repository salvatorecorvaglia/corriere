/**
 * Whether a value is raw binary data — a `Blob` (including `File`), an `ArrayBuffer`, a
 * typed array or `DataView`, or a Node `Buffer` — as opposed to a plain object to walk,
 * clone, redact or serialize. Every check is guarded so the helper is safe in runtimes that
 * lack one of these globals.
 */
export function isBinaryData(value: unknown): boolean {
  return (
    (typeof Blob !== 'undefined' && value instanceof Blob) ||
    (typeof File !== 'undefined' && value instanceof File) ||
    (typeof ArrayBuffer !== 'undefined' &&
      (value instanceof ArrayBuffer || ArrayBuffer.isView(value))) ||
    (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))
  );
}

/** Whether a value is a web `ReadableStream`. */
export function isReadableStream(value: unknown): value is ReadableStream {
  return typeof ReadableStream !== 'undefined' && value instanceof ReadableStream;
}
