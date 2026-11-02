import CorriereError from '../core/corriereError';
import type { CorriereRequestConfig, CorriereResponse, ServerSentEvent } from '../types';

export const DEFAULT_MAX_STREAM_LINE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_STREAM_EVENT_BYTES = 8 * 1024 * 1024;

export function validateStreamLimits(config: CorriereRequestConfig): void {
  for (const name of ['maxStreamLineBytes', 'maxStreamEventBytes'] as const) {
    const value = config[name];
    if (value !== undefined && value !== Infinity && (!Number.isSafeInteger(value) || value < 0)) {
      throw new CorriereError(
        `${name} must be a non-negative safe integer or Infinity`,
        CorriereError.ERR_BAD_OPTION_VALUE,
        config,
        null,
        null,
      );
    }
  }
}

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (code > 0xffff) i++;
  }
  return bytes;
}

/**
 * Turns the decoded lines of a streamed body into the values `stream()` yields. `line` is
 * called once per complete line (terminator removed); `end` once the body is exhausted.
 */
interface LineParser {
  line(line: string): Generator<unknown>;
  end(): Generator<unknown>;
}

function parseJSONOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The parser for every body that is not `text/event-stream`: each non-blank line is yielded
 * on its own — parsed as JSON when it looks like JSON, as text otherwise — with a leading
 * `data:` unwrapped, so line-delimited JSON and loosely SSE-shaped text both work.
 */
function createTextLineParser(): LineParser {
  return {
    *line(raw) {
      const trimmed = raw.trim();
      if (trimmed.startsWith('data:')) {
        const dataStr = trimmed.replace(/^data:\s*/, '');
        if (dataStr === '[DONE]') return;
        yield parseJSONOrText(dataStr);
      } else if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        yield parseJSONOrText(trimmed);
      } else if (trimmed) {
        yield trimmed;
      }
    },
    *end() {},
  };
}

/**
 * A Server-Sent Events parser, per the HTML spec's event-stream interpretation: `data:`
 * lines accumulate (joined with `\n`) until a blank line dispatches the event; `event:`,
 * `id:`, `retry:` and `:` comment lines are not data and are skipped. Each event's data is
 * yielded parsed as JSON when it parses, as text otherwise, and the conventional `[DONE]`
 * terminator is dropped.
 *
 * One deliberate leniency: the spec discards a final event that is not followed by a blank
 * line, but plenty of servers close the stream without one, so it is delivered instead.
 *
 * With `events`, each event is yielded as a `ServerSentEvent` carrying its type, the last
 * event ID and any `retry` value, instead of just its data. As the spec describes, the
 * event type resets after every dispatch while the last event ID carries over; a `retry`
 * is attached to the next event dispatched, so one sent on its own is not lost.
 */
function createEventStreamParser(options: {
  events?: boolean;
  maxBytes: number;
  onLimit: () => never;
}): LineParser {
  let eventBytes = 0;
  let data: string[] = [];
  let eventType = '';
  let lastEventId = '';
  let retry: number | undefined;

  function* dispatch(): Generator<unknown> {
    const type = eventType;
    eventType = '';
    if (data.length === 0) return;
    const payload = data.join('\n');
    data = [];
    if (payload === '[DONE]') return;
    const parsed = parseJSONOrText(payload);
    if (!options.events) {
      yield parsed;
      return;
    }
    const event: ServerSentEvent = { event: type || 'message', data: parsed };
    if (lastEventId) event.id = lastEventId;
    if (retry !== undefined) {
      event.retry = retry;
      retry = undefined;
    }
    yield event;
  }

  return {
    *line(raw) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line === '') {
        eventBytes = 0;
        yield* dispatch();
        return;
      }
      eventBytes += utf8Bytes(line) + 1;
      if (eventBytes > options.maxBytes) options.onLimit();
      if (line.startsWith(':')) return;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      switch (field) {
        case 'data':
          data.push(value);
          break;
        case 'event':
          eventType = value;
          break;
        case 'id':
          // The spec ignores an id containing NUL.
          if (!value.includes('\0')) lastEventId = value;
          break;
        case 'retry':
          if (/^\d+$/.test(value)) retry = Number(value);
          break;
      }
    },
    *end() {
      yield* dispatch();
    },
  };
}

function isEventStream(headers: CorriereResponse['headers'] | undefined): boolean {
  const value = headers?.['content-type'];
  const contentType = Array.isArray(value) ? value[0] : value;
  return typeof contentType === 'string' && /^\s*text\/event-stream\b/i.test(contentType);
}

/**
 * Reads a `responseType: 'stream'` response and yields its contents: Server-Sent Events
 * for `text/event-stream`, one value per line for anything else. Works with a web
 * `ReadableStream` or any async iterable of chunks (a Node stream, say), and releases the
 * stream when iteration ends early.
 */
export async function* readStreamBody<T = any>(
  response: CorriereResponse<any>,
): AsyncGenerator<T, void, unknown> {
  if (!response.data) return;

  const stream = response.data;
  const decoder = new TextDecoder();
  const lineLimit = response.config?.maxStreamLineBytes ?? DEFAULT_MAX_STREAM_LINE_BYTES;
  const eventLimit = response.config?.maxStreamEventBytes ?? DEFAULT_MAX_STREAM_EVENT_BYTES;
  const exceeded = (name: string, limit: number): never => {
    throw new CorriereError(
      `${name} size of ${limit} bytes exceeded`,
      CorriereError.ERR_BAD_RESPONSE,
      response.config,
      response.request,
      response,
    );
  };
  const eventStream = isEventStream(response.headers);
  const parser = eventStream
    ? createEventStreamParser({
        events: response.config?.sseEvents === true,
        maxBytes: eventLimit,
        onLimit: () => exceeded('maxStreamEventBytes', eventLimit),
      })
    : createTextLineParser();
  let fragments: string[] = [];
  let skipLF = false;
  let lineBytes = 0;
  let previousHighSurrogate = false;

  // Scan each decoded chunk once. Keep partial-line pieces without repeatedly
  // concatenating and rescanning an ever-growing unfinished line.
  const handleText = function* (text: string): Generator<unknown> {
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (skipLF) {
        skipLF = false;
        if (char === '\n') {
          start = i + 1;
          continue;
        }
      }
      if (char === '\n' || (eventStream && char === '\r')) {
        fragments.push(text.slice(start, i));
        const line = fragments.join('');
        fragments = [];
        start = i + 1;
        skipLF = eventStream && char === '\r';
        lineBytes = 0;
        previousHighSurrogate = false;
        yield* parser.line(line);
      } else {
        const code = text.charCodeAt(i);
        const lowSurrogate = code >= 0xdc00 && code <= 0xdfff;
        lineBytes +=
          lowSurrogate && previousHighSurrogate ? 1 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
        previousHighSurrogate = code >= 0xd800 && code <= 0xdbff;
        if (lineBytes > lineLimit) exceeded('maxStreamLineBytes', lineLimit);
      }
    }
    if (start < text.length) fragments.push(text.slice(start));
  };

  const handleChunk = function* (chunk: any): Generator<any> {
    const text =
      chunk instanceof Uint8Array || ArrayBuffer.isView(chunk) || chunk instanceof ArrayBuffer
        ? decoder.decode(chunk as any, { stream: true })
        : String(chunk);
    yield* handleText(text);
  };

  if (typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    try {
      validateStreamLimits(response.config ?? {});
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield* handleChunk(value);
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // ignore errors on cancel
      }
      reader.releaseLock();
    }
  } else if (typeof stream[Symbol.asyncIterator] === 'function') {
    try {
      validateStreamLimits(response.config ?? {});
      for await (const chunk of stream) {
        yield* handleChunk(chunk);
      }
    } finally {
      if (typeof stream.destroy === 'function') {
        try {
          stream.destroy();
        } catch {
          // ignore
        }
      }
    }
  } else {
    throw new Error('[Corriere] The response data is not a readable stream or async iterable.');
  }

  yield* handleText(decoder.decode()) as Generator<T>;
  if (fragments.length) {
    yield* parser.line(fragments.join('')) as Generator<T>;
  }
  yield* parser.end() as Generator<T>;
}
