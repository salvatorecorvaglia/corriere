import { describe, expectTypeOf, it } from 'vitest';
import type { RequestRegistry } from '../src/core/request';
import corriere, {
  type CacheProvider,
  type CorriereError,
  type CorriereHeaders,
  type CorriereInstance,
  type CorriereRequestConfig,
  type CorriereResponse,
  type ServerSentEvent,
} from '../src/index';

/**
 * Type-level checks of the public API. `expectTypeOf` does nothing at runtime; these are
 * enforced by `pnpm typecheck`, which compiles `tests/`. Lines marked `@ts-expect-error`
 * fail the typecheck if they ever start compiling — each one is a mistake the types must
 * keep rejecting. They sit in functions that are never called, so nothing runs.
 */
describe('public types', () => {
  it('types configurable memory protections without removing existing constructors', () => {
    const cache = new corriere.MemoryCache(1000, 64 * 1024 * 1024);
    expectTypeOf(cache.estimatedBytes).toEqualTypeOf<number>();
    expectTypeOf({
      maxStreamLineBytes: Infinity,
      maxStreamEventBytes: 1024,
    }).toMatchTypeOf<CorriereRequestConfig>();
    new corriere.MemoryCache();
    new corriere.MemoryCache(1000);
    const neverRun = () => {
      // @ts-expect-error — cache byte budgets are numeric
      new corriere.MemoryCache(1000, '64 MiB');
      // @ts-expect-error — accounting is read-only
      cache.estimatedBytes = 0;
      // @ts-expect-error — parser limits are numeric
      corriere.create({ maxStreamLineBytes: 'unlimited' });
    };
    void neverRun;
  });
  it('types the default export and its methods', () => {
    expectTypeOf(corriere.get<{ id: number }>).returns.toEqualTypeOf<
      Promise<CorriereResponse<{ id: number }>>
    >();
    expectTypeOf(corriere.post).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(corriere).toBeCallableWith('https://api.test.com');
    expectTypeOf(corriere).toBeCallableWith({ url: 'https://api.test.com' });
    expectTypeOf(corriere.defaults).toEqualTypeOf<CorriereRequestConfig>();

    const neverRun = () => {
      // @ts-expect-error — there is no such method; with the default export typed `any`
      // this used to compile.
      corriere.gett('/x');
      // @ts-expect-error — the second argument of get() is a config object
      corriere.get('/x', 5);
    };
    void neverRun;
  });

  it('types create() and the instances it returns', () => {
    const client = corriere.create({ baseURL: 'https://api.test.com' });
    expectTypeOf(client).toEqualTypeOf<CorriereInstance>();
    expectTypeOf(client.stream<string>).returns.toEqualTypeOf<
      AsyncGenerator<string, void, unknown>
    >();
    expectTypeOf(client.autoPaginate<number>).returns.toEqualTypeOf<
      AsyncGenerator<number, void, unknown>
    >();

    const neverRun = () => {
      // @ts-expect-error — create() takes a config object
      corriere.create('https://api.test.com');
    };
    void neverRun;
  });

  it('types interceptors with the value they receive', () => {
    const client = corriere.create();

    client.interceptors.request.use((config) => {
      expectTypeOf(config).toEqualTypeOf<CorriereRequestConfig>();
      return config;
    });
    client.interceptors.request.use(async (config) => ({ ...config, timeout: 1 }));
    client.interceptors.response.use((response) => {
      expectTypeOf(response).toEqualTypeOf<CorriereResponse>();
      return response;
    });
    // A response interceptor may reshape what the call resolves with.
    client.interceptors.response.use((response) => response.data);

    const neverRun = () => {
      // @ts-expect-error — a request interceptor must hand back a config
      client.interceptors.request.use(() => 42);
    };
    void neverRun;
  });

  it('lets grouped and flat headers be mixed', () => {
    const headers: CorriereHeaders = {
      common: { Accept: 'application/json' },
      post: { 'Content-Type': 'application/json' },
      Authorization: 'Bearer token',
      'X-Many': ['a', 'b'],
      'X-Optional': undefined,
    };
    expectTypeOf(headers).toMatchTypeOf<CorriereRequestConfig['headers']>();

    const neverRun = () => {
      // @ts-expect-error — header values are strings or string arrays
      const bad: CorriereHeaders = { 'X-Count': 5 };
      void bad;
    };
    void neverRun;
  });

  it('narrows unknown values with isCancel and isCorriereError', () => {
    const value: unknown = null;
    if (corriere.isCancel(value)) {
      expectTypeOf(value).toEqualTypeOf<CorriereError>();
    }
    if (corriere.isCorriereError(value)) {
      expectTypeOf(value.code).toEqualTypeOf<string | null>();
      expectTypeOf(value.response).toEqualTypeOf<CorriereResponse | null>();
    }
  });

  it('uses the CorriereError class as the error type everywhere', () => {
    expectTypeOf<CorriereError>().toEqualTypeOf<InstanceType<typeof corriere.CorriereError>>();
    expectTypeOf<NonNullable<CorriereRequestConfig['retryCondition']>>()
      .parameter(0)
      .toEqualTypeOf<CorriereError>();
  });

  it('types SSE events for stream()', () => {
    const client = corriere.create();
    expectTypeOf(client.stream<ServerSentEvent<{ a: number }>>).returns.toEqualTypeOf<
      AsyncGenerator<ServerSentEvent<{ a: number }>, void, unknown>
    >();
    expectTypeOf<ServerSentEvent['event']>().toEqualTypeOf<string>();
    expectTypeOf<ServerSentEvent['id']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<CorriereRequestConfig['sseEvents']>().toEqualTypeOf<boolean | undefined>();
  });

  it('keeps stored cache entries distinct from finalized responses', () => {
    type Entry = NonNullable<Awaited<ReturnType<RequestRegistry['cache']['get']>>>;
    expectTypeOf<Entry>().toEqualTypeOf<Omit<CorriereResponse<unknown>, 'config'>>();
    expectTypeOf<Entry['data']>().toBeUnknown();
    expectTypeOf<RequestRegistry['cache']['set']>().parameter(1).toEqualTypeOf<Entry>();

    const neverRun = (entry: Entry, registry: RequestRegistry) => {
      // @ts-expect-error — cached responses have no caller configuration
      entry.config;
      // @ts-expect-error — cached data requires narrowing before property access
      entry.data.id;
      // @ts-expect-error — replay must attach a config before producing a full response
      const response: CorriereResponse = entry;
      // @ts-expect-error — the internal response cache cannot accept arbitrary values
      registry.cache.set('key', 42);
      void response;
    };
    void neverRun;
  });

  it('requires subscriber errors to be narrowed and subscribers to receive full responses', () => {
    type Record = RequestRegistry['inflight'] extends Map<string, infer R> ? R : never;
    type Subscriber = Record['subscribers'] extends Set<infer S> ? S : never;
    expectTypeOf<Subscriber['reject']>().parameter(0).toBeUnknown();
    expectTypeOf<Subscriber['resolve']>().parameter(0).toEqualTypeOf<CorriereResponse<unknown>>();
    expectTypeOf<Awaited<Record['promise']>>().toEqualTypeOf<CorriereResponse<unknown>>();

    const neverRun = (subscriber: Subscriber, value: Parameters<Subscriber['reject']>[0]) => {
      // @ts-expect-error — arbitrary thrown values do not necessarily have a message
      value.message;
      subscriber.reject('a non-Error rejection is still supported');
      // @ts-expect-error — subscribers cannot resolve with response data alone
      subscriber.resolve({ data: 42 });
    };
    void neverRun;
  });

  it('preserves permissive public custom cache providers and synchronous invalidation', () => {
    const provider: CacheProvider = {
      get: async () => ({ value: 'provider-specific storage' }),
      set: (_key, _value: unknown) => {},
      delete: async () => {},
      clear: () => {},
    };
    expectTypeOf({ cache: provider }).toMatchTypeOf<CorriereRequestConfig>();
    expectTypeOf(corriere.invalidate).returns.toBeVoid();
    expectTypeOf(corriere.MemoryCache).instance.toMatchTypeOf<CacheProvider>();
  });
});
