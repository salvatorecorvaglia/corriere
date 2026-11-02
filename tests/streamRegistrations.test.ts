import { afterEach, describe, expect, it, vi } from 'vitest';
import Corriere from '../src/corriere';

afterEach(() => vi.restoreAllMocks());

async function trackedBody(body: ReadableStream) {
  const register = vi.spyOn(FinalizationRegistry.prototype, 'register');
  const unregister = vi.spyOn(FinalizationRegistry.prototype, 'unregister');
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  const response = await new Corriere().get<ReadableStream>('https://example.test', {
    signal: controller.signal,
    timeout: 60_000,
    responseType: 'stream',
    fetch: async () => new Response(body),
  });
  // Native Response construction also uses finalizers; observe only our stream.
  const registrations = register.mock.calls.filter(
    ([target, held]) => target === response.data && typeof held === 'function',
  );
  expect(registrations).toHaveLength(1);
  const [target, heldCleanup, token] = registrations[0];
  expect(target).toBe(response.data);
  expect(typeof heldCleanup).toBe('function');
  expect(token).toBeDefined();
  expect(token).not.toBe(target);
  const unregisterCalls = () => unregister.mock.calls.filter(([key]) => key === token);
  expect(unregisterCalls()).toHaveLength(0);
  return {
    body: response.data,
    unregisterCalls,
    token,
    heldCleanup: heldCleanup as () => void,
    remove,
  };
}

describe('stream finalizer registrations', () => {
  it('unregisters once on EOF, even if the reader is then canceled', async () => {
    const tracked = await trackedBody(
      new ReadableStream({
        start(c) {
          c.close();
        },
      }),
    );
    const reader = tracked.body.getReader();
    expect(await reader.read()).toMatchObject({ done: true });
    await reader.cancel();
    tracked.heldCleanup();
    expect(tracked.unregisterCalls()).toHaveLength(1);
    expect(tracked.remove.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(1);
  });

  it('unregisters when stream cancellation rejects, preserving the rejection', async () => {
    const failure = new Error('cancel failed');
    const tracked = await trackedBody(
      new ReadableStream({
        cancel() {
          throw failure;
        },
      }),
    );
    await expect(tracked.body.cancel()).rejects.toBe(failure);
    expect(tracked.unregisterCalls()).toHaveLength(1);
    expect(tracked.remove.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(1);
  });

  it('unregisters on a reader error', async () => {
    const failure = new Error('read failed');
    const tracked = await trackedBody(
      new ReadableStream({
        pull(c) {
          c.error(failure);
        },
      }),
    );
    await expect(tracked.body.getReader().read()).rejects.toBe(failure);
    expect(tracked.unregisterCalls()).toHaveLength(1);
  });

  it('unregisters on early iterator return', async () => {
    const tracked = await trackedBody(
      new ReadableStream({
        pull(c) {
          c.enqueue(new Uint8Array([1]));
        },
      }),
    );
    for await (const _ of tracked.body as ReadableStream & AsyncIterable<Uint8Array>) break;
    expect(tracked.unregisterCalls()).toHaveLength(1);
  });

  it('keeps the finalizer fallback idempotent with explicit cancellation', async () => {
    const tracked = await trackedBody(new ReadableStream());
    tracked.heldCleanup();
    await tracked.body.cancel();
    expect(tracked.unregisterCalls()).toHaveLength(1);
    expect(tracked.remove.mock.calls.filter(([event]) => event === 'abort')).toHaveLength(1);
  });
});
