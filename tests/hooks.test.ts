import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dispatchRequest from '../src/core/request';

function serve(status: number, body: Record<string, unknown> = { ok: true }) {
  global.fetch = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  ) as any;
}

describe('config.hooks', () => {
  beforeEach(() => {
    serve(200);
  });

  describe('onBeforeRequest', () => {
    it('is called before the request is dispatched', async () => {
      const order: string[] = [];
      const onBeforeRequest = vi.fn(async () => {
        order.push('hook');
      });
      (global.fetch as any).mockImplementationOnce(() => {
        order.push('fetch');
        return Promise.resolve(
          new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
        );
      });

      await dispatchRequest({
        url: 'https://api.test.com/x',
        method: 'get',
        hooks: { onBeforeRequest },
      });

      expect(onBeforeRequest).toHaveBeenCalledTimes(1);
      expect(order).toEqual(['hook', 'fetch']);
    });

    it('prevents dispatch when it throws', async () => {
      const onBeforeRequest = vi.fn(async () => {
        throw new Error('blocked');
      });

      await expect(
        dispatchRequest({
          url: 'https://api.test.com/x',
          method: 'get',
          hooks: { onBeforeRequest },
        }),
      ).rejects.toThrow('blocked');
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('onRequestResponse', () => {
    it('is called with the settled response on success', async () => {
      const onRequestResponse = vi.fn();
      const response = await dispatchRequest({
        url: 'https://api.test.com/x',
        method: 'get',
        hooks: { onRequestResponse },
      });
      expect(onRequestResponse).toHaveBeenCalledTimes(1);
      expect(onRequestResponse.mock.calls[0][0]).toBe(response);
    });

    it('is called independently for each dedupe subscriber', async () => {
      const hookA = vi.fn();
      const hookB = vi.fn();
      const [a, b] = await Promise.all([
        dispatchRequest({
          url: 'https://api.test.com/shared-ok',
          method: 'get',
          dedupe: true,
          hooks: { onRequestResponse: hookA },
        }),
        dispatchRequest({
          url: 'https://api.test.com/shared-ok',
          method: 'get',
          dedupe: true,
          hooks: { onRequestResponse: hookB },
        }),
      ]);
      expect(hookA).toHaveBeenCalledTimes(1);
      expect(hookB).toHaveBeenCalledTimes(1);
      expect(hookA.mock.calls[0][0]).toBe(a);
      expect(hookB.mock.calls[0][0]).toBe(b);
    });
  });

  describe('onRequestError', () => {
    const failStatus = (s: number) => s < 400;

    it('is called with the CorriereError on a failed request', async () => {
      serve(500);
      const onRequestError = vi.fn();
      await expect(
        dispatchRequest({
          url: 'https://api.test.com/x',
          method: 'get',
          validateStatus: failStatus,
          hooks: { onRequestError },
        }),
      ).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE' });
      expect(onRequestError).toHaveBeenCalledTimes(1);
      expect(onRequestError.mock.calls[0][0]).toMatchObject({ code: 'ERR_BAD_RESPONSE' });
    });

    it('does not mask the original error when the hook itself throws', async () => {
      serve(500);
      const onRequestError = vi.fn(async () => {
        throw new Error('hook exploded');
      });
      await expect(
        dispatchRequest({
          url: 'https://api.test.com/x',
          method: 'get',
          validateStatus: failStatus,
          hooks: { onRequestError },
        }),
      ).rejects.toMatchObject({ code: 'ERR_BAD_RESPONSE' });
    });

    it('is called independently for each dedupe subscriber on failure', async () => {
      serve(500);
      const hookA = vi.fn();
      const hookB = vi.fn();
      const results = await Promise.allSettled([
        dispatchRequest({
          url: 'https://api.test.com/shared-err',
          method: 'get',
          dedupe: true,
          validateStatus: failStatus,
          hooks: { onRequestError: hookA },
        }),
        dispatchRequest({
          url: 'https://api.test.com/shared-err',
          method: 'get',
          dedupe: true,
          validateStatus: failStatus,
          hooks: { onRequestError: hookB },
        }),
      ]);
      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('rejected');
      expect(hookA).toHaveBeenCalledTimes(1);
      expect(hookB).toHaveBeenCalledTimes(1);
    });

    describe('unhandled-rejection safety', () => {
      let unhandled: ReturnType<typeof vi.fn>;

      beforeEach(() => {
        unhandled = vi.fn();
        process.on('unhandledRejection', unhandled as unknown as NodeJS.UnhandledRejectionListener);
      });

      afterEach(() => {
        process.off(
          'unhandledRejection',
          unhandled as unknown as NodeJS.UnhandledRejectionListener,
        );
      });

      it('does not leak an unhandled rejection when a dedupe subscriber error hook throws', async () => {
        serve(500);
        const throwingHook = vi.fn(async () => {
          throw new Error('boom');
        });

        await Promise.allSettled([
          dispatchRequest({
            url: 'https://api.test.com/shared-err-hook-throws',
            method: 'get',
            dedupe: true,
            validateStatus: (s) => s < 400,
            hooks: { onRequestError: throwingHook },
          }),
        ]);

        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(unhandled).not.toHaveBeenCalled();
      });

      it('does not leak an unhandled rejection when a schema failure and the follow-up onRequestError both throw (dedupe)', async () => {
        // Schema failure throws an CorriereError from inside the resolve-branch's
        // `finalizeAndSettle`, which is what actually routes into `onRequestError` there
        // (the guard only fires for CorriereError instances) — this is the path that
        // exercises the try/catch added around that hook call.
        const failingSchema = {
          parse: vi.fn(() => {
            throw new Error('schema failed');
          }),
        };
        const onRequestError = vi.fn(async () => {
          throw new Error('error hook also failed');
        });

        await expect(
          dispatchRequest({
            url: 'https://api.test.com/shared-schemafail',
            method: 'get',
            dedupe: true,
            schema: failingSchema,
            hooks: { onRequestError },
          }),
        ).rejects.toThrow();

        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(unhandled).not.toHaveBeenCalled();
        expect(onRequestError).toHaveBeenCalledTimes(1);
      });
    });
  });
});
