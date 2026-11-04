import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import corriere from '../esm/index.js';

// Exercise native Fetch against sockets: mocks cannot catch RequestInit requirements
// or aborts after headers have arrived. Run after building the package.
const redirectClosures = [];
const streamClosures = [];
const lifecycleClosures = new Map();
const retryAttempts = new Map();
const server = createServer(async (request, response) => {
  if (request.url === '/pagination/start') {
    response.writeHead(302, { location: '/pagination/moved/items?page=1' });
    response.end();
  } else if (request.url.startsWith('/pagination/moved/items')) {
    const page = new URL(request.url, 'http://localhost').searchParams.get('page');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ items: [Number(page)], next: page === '1' ? '?page=2' : null }));
  } else if (request.url === '/retry-policy') {
    const key = request.headers['x-scenario'];
    const attempts = (retryAttempts.get(key) ?? 0) + 1;
    retryAttempts.set(key, attempts);
    response.writeHead(attempts === 1 ? 429 : 200, {
      'content-type': 'application/json',
      'retry-after': '0',
    });
    response.end('{}');
  } else if (request.url.startsWith('/lifecycle/')) {
    lifecycleClosures.set(request.url, new Promise((resolve) => response.once('close', resolve)));
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('chunk');
  } else if (request.url === '/complete') {
    response.end('done');
  } else if (request.url === '/long-line') {
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

test('a throwing progress callback closes the native connection', { timeout: 5000 }, async () => {
  const failure = new Error('progress observer failed');
  await assert.rejects(
    corriere.get(`${baseURL}/lifecycle/progress`, {
      onDownloadProgress() {
        throw failure;
      },
    }),
    (error) => error.code === 'ERR_BAD_RESPONSE' && error.cause === failure,
  );
  assert.ok(lifecycleClosures.has('/lifecycle/progress'));
  await lifecycleClosures.get('/lifecycle/progress');
});

test('a failing pipe destination closes the native connection', { timeout: 5000 }, async () => {
  const failure = new Error('destination failed');
  const response = await corriere.get(`${baseURL}/lifecycle/pipe`, { responseType: 'stream' });
  await assert.rejects(
    response.data.pipeTo(
      new WritableStream({
        write() {
          throw failure;
        },
      }),
    ),
    (error) => error === failure,
  );
  await lifecycleClosures.get('/lifecycle/pipe');
});

test('native BYOB and piping consumption release timeout wiring', { timeout: 5000 }, async () => {
  for (const mode of ['byob', 'pipe']) {
    const controller = new AbortController();
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
    let removed = 0;
    controller.signal.removeEventListener = (...args) => {
      if (args[0] === 'abort') removed++;
      return originalRemove(...args);
    };
    const response = await corriere.get(`${baseURL}/complete`, {
      signal: controller.signal,
      timeout: 2000,
      responseType: 'stream',
      maxContentLength: 100,
    });
    const bytes = [];
    if (mode === 'byob') {
      const reader = response.data.getReader({ mode: 'byob' });
      while (true) {
        const { value, done } = await reader.read(new Uint8Array(16));
        if (done) break;
        bytes.push(...value);
      }
      reader.releaseLock();
    } else {
      await response.data.pipeTo(
        new WritableStream({
          write(chunk) {
            bytes.push(...chunk);
          },
        }),
      );
    }
    assert.equal(Buffer.from(bytes).toString(), 'done');
    assert.equal(removed, 1);
  }
});

for (const mode of ['timeout', 'abort']) {
  test(`a native stream ${mode} closes the connection and releases wiring`, {
    timeout: 5000,
  }, async () => {
    const controller = new AbortController();
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
    let removed = 0;
    controller.signal.removeEventListener = (...args) => {
      if (args[0] === 'abort') removed++;
      return originalRemove(...args);
    };
    const path = `/lifecycle/${mode}`;
    const response = await corriere.get(`${baseURL}${path}`, {
      responseType: 'stream',
      signal: controller.signal,
      timeout: mode === 'timeout' ? 200 : 2000,
    });
    const reader = response.data.getReader();
    assert.equal((await reader.read()).done, false);
    const pending = reader.read();
    if (mode === 'abort') controller.abort();
    await assert.rejects(pending);
    reader.releaseLock();
    await lifecycleClosures.get(path);
    assert.equal(removed, 1);
  });
}

for (const maxRedirects of [undefined, 2]) {
  test(`native pagination resolves next links after redirects (maxRedirects=${maxRedirects})`, {
    timeout: 5000,
  }, async () => {
    const items = [];
    for await (const item of corriere.autoPaginate(`${baseURL}/pagination/start`, { maxRedirects }))
      items.push(item);
    assert.deepEqual(items, [1, 2]);
  });
}

test('native 429 retries respect the configured method allowlist', { timeout: 5000 }, async () => {
  for (const method of ['post', 'patch', 'get']) {
    const scenario = `default-${method}`;
    const request = corriere.request({
      url: `${baseURL}/retry-policy`,
      method,
      retryOn429: true,
      retryDelay: 0,
      headers: { 'X-Scenario': scenario },
    });
    if (method === 'get') await request;
    else await assert.rejects(request, (error) => error.response?.status === 429);
    assert.equal(retryAttempts.get(scenario), method === 'get' ? 2 : 1);
  }
  await corriere.post(
    `${baseURL}/retry-policy`,
    {},
    {
      retryOn429: true,
      retryMethods: ['post'],
      retryDelay: 0,
      headers: { 'X-Scenario': 'explicit-post' },
    },
  );
  assert.equal(retryAttempts.get('explicit-post'), 2);
});
