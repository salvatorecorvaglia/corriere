import { test as base, expect } from '@playwright/test';
import type { CorriereStatic } from '../../src/types';

declare global {
  interface Window {
    corriere: CorriereStatic;
  }
}

const test = base.extend<{ browserFaults: undefined }>({
  browserFaults: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await use(undefined);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => typeof window.corriere?.get === 'function');
});

test('loads the distributed ESM without Node globals and sends UTF-8 basic auth', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const response = await window.corriere.post<{ headers: Record<string, string>; body: string }>(
      '/echo',
      { value: 1 },
      { auth: { username: 'üser', password: 'päss' } },
    );
    return { data: response.data, buffer: typeof Buffer, process: typeof process };
  });
  expect(result.buffer).toBe('undefined');
  expect(result.process).toBe('undefined');
  expect(result.data.headers.authorization).toBe(
    `Basic ${Buffer.from('üser:päss').toString('base64')}`,
  );
  expect(JSON.parse(result.data.body)).toEqual({ value: 1 });
});

test('sends native multipart forms with nested fields and blobs', async ({ page }) => {
  const result = await page.evaluate(
    async () =>
      (
        await window.corriere.postForm<{ headers: Record<string, string>; body: string }>('/echo', {
          user: { name: 'Zoë' },
          file: new Blob(['file-bytes'], { type: 'text/plain' }),
        })
      ).data,
  );
  expect(result.headers['content-type']).toContain('multipart/form-data; boundary=');
  expect(result.body).toContain('name="user.name"');
  expect(result.body).toContain('Zoë');
  expect(result.body).toContain('file-bytes');
});

test('deduplicates native fetch and isolates cached response mutations', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const client = window.corriere.create({ cache: true, dedupe: true });
    const url = `/counted?key=${crypto.randomUUID()}`;
    const [first, second] = await Promise.all([
      client.get<{ count: number; nested: { value: number } }>(url),
      client.get<{ count: number; nested: { value: number } }>(url),
    ]);
    first.data.nested.value = 99;
    const third = await client.get(url);
    client.invalidate(url);
    const fourth = await client.get(url);
    return { second: second.data, third: third.data, fourth: fourth.data };
  });
  expect(result.second).toEqual({ count: 1, nested: { value: 1 } });
  expect(result.third).toEqual({ count: 1, nested: { value: 1 } });
  expect(result.fourth).toEqual({ count: 2, nested: { value: 1 } });
});

test('handles opaque manual redirects and normal native redirects', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const failure = await window.corriere
      .get('/redirect', { maxRedirects: 1 })
      .catch((error) => error);
    const success = await window.corriere.get('/redirect');
    return { code: failure.code, data: success.data, redirected: success.request.redirected };
  });
  expect(result).toEqual({ code: 'ERR_NOT_SUPPORT', data: { ok: true }, redirected: true });
});

test('streams SSE and resolves relative pagination against the browser origin', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const chunks = [];
    for await (const chunk of window.corriere.stream('/stream')) chunks.push(chunk);
    const items = [];
    for await (const item of window.corriere
      .create({ baseURL: '/api' })
      .autoPaginate('/items', { params: { page: 1, filter: 'active' } }))
      items.push(item);
    return { chunks, items };
  });
  expect(result).toEqual({ chunks: [{ value: 1 }, { value: 2 }], items: [1, 2] });
});

test('preserves native BYOB capability and releases lifecycle wiring after piping or reading', async ({
  page,
}) => {
  const results = await page.evaluate(async () => {
    const probe = await fetch('/stream');
    let nativeBYOB = false;
    try {
      const reader = probe.body!.getReader({ mode: 'byob' });
      nativeBYOB = true;
      await reader.cancel();
      reader.releaseLock();
    } catch {
      await probe.body!.cancel();
    }
    const results = [];
    for (const mode of ['pipe', 'reader']) {
      const abort = new AbortController();
      const remove = abort.signal.removeEventListener.bind(abort.signal);
      let removed = 0;
      abort.signal.removeEventListener = (
        ...args: Parameters<AbortSignal['removeEventListener']>
      ) => {
        if (args[0] === 'abort') removed++;
        return remove(...args);
      };
      const response = await window.corriere.get<ReadableStream<Uint8Array>>('/stream', {
        responseType: 'stream',
        maxContentLength: 1000,
        timeout: 5000,
        signal: abort.signal,
      });
      const chunks: number[] = [];
      if (mode === 'pipe')
        await response.data.pipeThrough(new TransformStream()).pipeTo(
          new WritableStream<Uint8Array>({
            write(chunk) {
              chunks.push(...chunk);
            },
          }),
        );
      else if (nativeBYOB) {
        const reader = response.data.getReader({ mode: 'byob' });
        while (true) {
          const { value, done } = await reader.read(new Uint8Array(64));
          if (done) break;
          chunks.push(...value!);
        }
        reader.releaseLock();
      } else {
        const reader = response.data.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(...value);
        }
        reader.releaseLock();
      }
      results.push({ removed, text: new TextDecoder().decode(new Uint8Array(chunks)) });
    }
    return results;
  });
  for (const result of results) {
    expect(result.removed).toBe(1);
    expect(result.text).toBe('data: {"value":1}\n\ndata: {"value":2}\n\n');
  }
});

test('retains timeout and cancellation identity while reading a native response', async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const timeout = await window.corriere.get('/slow', { timeout: 100 }).catch((error) => error);
    const abort = new AbortController();
    const canceled = await window.corriere
      .get('/slow', {
        signal: abort.signal,
        fetch: async (...args) => {
          const response = await fetch(...args);
          abort.abort();
          return response;
        },
      })
      .catch((error) => error);
    return { timeout: timeout.code, canceled: canceled.code };
  });
  expect(result).toEqual({ timeout: 'ETIMEDOUT', canceled: 'ERR_CANCELED' });
});

test('redacts serialized browser errors and enforces parser limits', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const error = await window.corriere
      .post('/failure', '{"password":"private-body"}', {
        params: { filter: [{ token: 'private-query' }] },
      })
      .catch((error) => error);
    let limit: string | undefined;
    try {
      for await (const _ of window.corriere.stream('/stream', { maxStreamLineBytes: 1 })) {
      }
    } catch (error) {
      limit = (error as { code: string }).code;
    }
    return { serialized: JSON.stringify(error), limit };
  });
  expect(result.serialized).not.toContain('private-body');
  expect(result.serialized).not.toContain('private-query');
  expect(result.limit).toBe('ERR_BAD_RESPONSE');
});
