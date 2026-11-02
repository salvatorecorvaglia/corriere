import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import corriere from '../esm/index.js';

// Exercise native Fetch against sockets: mocks cannot catch RequestInit requirements
// or aborts after headers have arrived. Run after building the package.
const redirectClosures = [];
const streamClosures = [];
const server = createServer(async (request, response) => {
  if (request.url === '/long-line') {
    streamClosures.push(new Promise((resolve) => response.once('close', resolve)));
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('x'.repeat(65));
  } else if (request.url === '/redirect-loop') {
    redirectClosures.push(new Promise((resolve) => response.once('close', resolve)));
    response.writeHead(302, { location: '/redirect-loop' });
    response.write('discarded redirect body');
  } else if (request.url === '/upload') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.end(Buffer.concat(chunks));
  } else {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{');
    // Deliberately leave the body open until the caller cancels it.
  }
});

test('stream line limits cancel the native connection', { timeout: 5000 }, async () => {
  await assert.rejects(
    (async () => {
      for await (const _ of corriere.stream(`${baseURL}/long-line`, { maxStreamLineBytes: 64 })) {
        /* drain */
      }
    })(),
    (error) => error.code === 'ERR_BAD_RESPONSE',
  );
  assert.equal(streamClosures.length, 1);
  await Promise.all(streamClosures);
});
let baseURL;
before(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseURL = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('native Fetch accepts streamed uploads', { timeout: 5000 }, async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('streamed payload'));
      controller.close();
    },
  });
  const response = await corriere.post(`${baseURL}/upload`, body, { responseType: 'text' });
  assert.equal(response.data, 'streamed payload');
});

test('abort after native response headers stays a cancellation', { timeout: 5000 }, async () => {
  const controller = new AbortController();
  await assert.rejects(
    corriere.get(`${baseURL}/slow`, {
      signal: controller.signal,
      fetch: async (...args) => {
        const response = await fetch(...args);
        controller.abort();
        return response;
      },
    }),
    (error) => {
      assert.equal(error.code, 'ERR_CANCELED');
      assert.equal(corriere.isCancel(error), true);
      return true;
    },
  );
});

test('timeout while reading a native body stays ETIMEDOUT and retries', {
  timeout: 5000,
}, async () => {
  let calls = 0;
  let receivedHeaders = false;
  const retryCodes = [];
  const result = await corriere.get(`${baseURL}/slow`, {
    timeout: 200,
    retry: 1,
    retryDelay: 0,
    fetch: async (...args) => {
      calls++;
      if (calls > 1)
        return new Response('{"retried":true}', {
          headers: { 'content-type': 'application/json' },
        });
      const response = await fetch(...args);
      receivedHeaders = true;
      return response;
    },
    onRetry(_attempt, error) {
      retryCodes.push(error.code);
    },
  });
  assert.deepEqual(retryCodes, ['ETIMEDOUT']);
  assert.equal(receivedHeaders, true);
  assert.equal(calls, 2);
  assert.equal(result.data.retried, true);
});

test('rejected redirect chains close every discarded native response', {
  timeout: 5000,
}, async () => {
  await assert.rejects(
    corriere.get(`${baseURL}/redirect-loop`, { maxRedirects: 1 }),
    (error) => error.code === 'ERR_FR_TOO_MANY_REDIRECTS',
  );
  assert.equal(redirectClosures.length, 2);
  await Promise.all(redirectClosures);
});
