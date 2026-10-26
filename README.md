# Corriere 🚚

**Fast, flexible, zero-dependency modern HTTP client for JS/TS**

**Corriere** is a lightweight, modern HTTP client built on top of the native fetch API. It provides a familiar, Promise-based interface with advanced features like interceptors, automatic retries, rate limiting, and structured debug logging, all while maintaining zero external dependencies.

---

## Features ✨

- 📦 **Zero Dependencies** — Ultra-lightweight codebase leveraging native `fetch`.
- 🧩 **Dual-Module Support** — Shipping fully compatible ES Modules (ESM) and CommonJS (CJS) builds.
- 🔒 **Type-Safe** — Written from the ground up in TypeScript with exported first-class typings.
- 📡 **HTTP Shorthand Methods** — `get`, `post`, `put`, `delete`, `options`, `patch`, `head`.
- 📝 **Form Submissions** — Helper methods like `postForm`, `putForm`, and `patchForm` for simple `multipart/form-data` uploads, with nested objects, arrays, `Map`, and `Set` values serialized automatically.
- 🌊 **Streaming** — Consume server responses line-by-line using async generators (`stream`), including the common `data: …` SSE shape.
- 📃 **Auto-Pagination** — Effortless cursored/linked API pagination with `autoPaginate`.
- 🕸️ **GraphQL Support** — Sane GraphQL POST request shortcut (`gql`).
- ⚡ **Interceptors** — Both synchronous and asynchronous request/response hooks.
- 🔄 **Advanced Retries** — Automatic retries with customizable delay, backoff limits, and conditions (e.g., retrying on 429).
- 🚦 **Rate Limiting** — Custom concurrent and queued request rate-limiting with cancellation support.
- 👥 **Request Deduplication** — De-duplicates active identical inflight GET requests to optimize performance.
- 💾 **Response Caching** — Per-instance memory cache with TTL, mutation protection (cloning) and explicit invalidation, or plug in your own store.
- 🔍 **Schema Validation** — Seamless validation hooks using Zod, Valibot, or custom schemas.
- 📊 **Download Progress Tracking** — Real-time progress monitoring (`onDownloadProgress`) as a response body is read.

---

## Installation 📦

Install Corriere using your preferred package manager:

```bash
# Using pnpm (recommended)
pnpm add corriere

# Using npm
npm install corriere

# Using yarn
yarn add corriere

# Using bun
bun add corriere
```

---

## Quick Start 🚀

### Basic Requests

```typescript
import corriere from 'corriere';

// Simple GET request
const response = await corriere.get('https://api.example.com/users/1');
console.log(response.data); // Automatically parsed JSON

// POST request with body
const createResponse = await corriere.post('https://api.example.com/users', {
  name: 'Salvatore Corvaglia',
  role: 'Developer',
});
```

### Custom Client Instances

Create instances with base configurations:

```typescript
import corriere from 'corriere';

const client = corriere.create({
  baseURL: 'https://api.example.com/v1',
  timeout: 5000,
  headers: {
    Authorization: 'Bearer YOUR_TOKEN',
  },
});

// Sends GET to https://api.example.com/v1/projects
const response = await client.get('/projects');
```

---

## Advanced Features 🛠️

### 1. Server-Sent Events & Streaming 🌊

Read streams using `async generators`. Each value is returned as parsed JSON when it parses and as a string otherwise.
- When the response is `text/event-stream`, the body is parsed as Server-Sent Events: each event yields its `data` (multi-line `data:` fields are joined with `\n`), `event:`/`id:`/`retry:`/comment lines are skipped, and a `[DONE]` event is dropped.
- Any other body is read line by line (split on `\n`), with a leading `data: ` unwrapped — this covers newline-delimited JSON.

```typescript
// Stream completions from an LLM endpoint
for await (const chunk of corriere.stream('https://api.example.com/chat/stream')) {
  console.log(chunk); // Parsed JSON chunk or raw text line
}
```

To see each Server-Sent Event's type and id too, pass `sseEvents: true`. Each value is then a
`ServerSentEvent` — `{ event, data, id?, retry? }` — where `event` defaults to `'message'` and
`id` is the last id the stream set:

```typescript
import corriere, { type ServerSentEvent } from 'corriere';

for await (const e of corriere.stream<ServerSentEvent>(url, { sseEvents: true })) {
  if (e.event === 'update') render(e.data);
}
```

### 2. Auto-Pagination 📃

Iterate through paginated APIs seamlessly. It automatically tracks `next` links or page tokens:

```typescript
// Automatically fetches next pages using standard link patterns
const pageGenerator = corriere.autoPaginate('https://api.example.com/items', {
  // Optional: customize page extraction mapping
  paginateItems: (data) => data.results,
});

for await (const item of pageGenerator) {
  console.log('Paginated item:', item);
}
```

### 3. GraphQL 🕸️

Perform GraphQL queries with a dedicated wrapper:

```typescript
const query = `
  query GetUser($id: ID!) {
    user(id: $id) {
      name
      email
    }
  }
`;

const response = await corriere.gql('https://api.example.com/graphql', query, { id: '123' });
console.log(response.data.user);
```

### 4. Caching 💾

Cache responses in memory to speed up repeated queries. It supports automated cloning so references don't mutate:

```typescript
const response = await corriere.get('https://api.example.com/config', {
  cache: true, // Enable caching
  cacheTTL: 60000, // TTL in milliseconds (1 minute)
});
```

Entries expire after `cacheTTL` (5 minutes by default). The cache stores the response as the
server sent it; each cache hit runs the caller's own `transformResponse`, `validateStatus` and
`schema`, exactly like a live request. `responseType: 'stream'` responses are never cached or
deduplicated, since a stream can only be read once. Each client owns its cache, so two
instances never serve each other's responses — and you can clear it explicitly:

```typescript
const client = corriere.create({ baseURL: 'https://api.example.com' });

await client.get('/config', { cache: true });

client.invalidate('/config', { cache: true }); // drop one entry
client.clearCache(); // drop everything
```

`invalidate()` computes the key from the instance defaults and the config you pass —
request interceptors do not run. If an interceptor adds a header to cached requests (an auth
token, say), pass the same header to `invalidate()`.

You can also pass a custom `CacheProvider` implementation matching the `CacheProvider` interface:
```typescript
interface CacheProvider {
  get: (key: string) => Promise<any> | any;
  set: (key: string, value: any, ttl?: number) => Promise<void> | void;
  delete: (key: string) => Promise<void> | void;
  clear: () => Promise<void> | void;
}
```

### 5. Request Deduplication 👥

Prevent sending multiple identical concurrent requests (e.g. on dashboard load). In-flight requests for the same endpoint are collapsed into a single call:

```typescript
// Only one network request is made; both calls receive the same response.
// Deduplication is per-instance: two clients never collapse into one request.
const [res1, res2] = await Promise.all([
  corriere.get('https://api.example.com/profile', { dedupe: true }),
  corriere.get('https://api.example.com/profile', { dedupe: true }),
]);
```

### 6. Rate Limiting 🚦

Control concurrent requests to protect client/server throughput constraints:

```typescript
import corriere, { createRateLimiter } from 'corriere';

// Allow maximum 3 concurrent requests, max queue size of 10
const limiter = createRateLimiter(3, 10);

const client = corriere.create({
  rateLimiter: limiter,
});
```

The limiter counts calls, not network requests. Identical calls collapsed by `dedupe` share
one request but each still holds a slot while it waits, so a burst of duplicates can fill the
limiter with a single request in flight.

### 7. Interceptors ⚡

Add custom middleware hooks to transform requests or handle responses/errors globally:

```typescript
const client = corriere.create();

// Add request interceptor
client.interceptors.request.use(
  (config) => {
    config.headers = { ...config.headers, 'X-Custom-Header': 'Corriere' };
    return config;
  },
  (error) => Promise.reject(error),
);

// Add response interceptor
client.interceptors.response.use(
  (response) => {
    console.log('Received response from:', response.config.url);
    return response;
  },
  (error) => {
    if (error.response?.status === 401) {
      // Handle unauthorized access globally
    }
    return Promise.reject(error);
  },
);
```

`use()` takes an optional third argument. `runWhen: (config) => boolean` skips a request
interceptor for configs it returns `false` for. `synchronous: true` marks a request
interceptor as not returning a promise; when every request interceptor is synchronous, the
request is dispatched without waiting an extra tick.

```typescript
client.interceptors.request.use(addAuthHeader, null, {
  synchronous: true,
  runWhen: (config) => !config.url?.startsWith('/public'),
});
```

### 8. Schema Validation 🔍

Pass Zod or Valibot schemas to automatically validate and type responses:

```typescript
import { z } from 'zod';

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});

const response = await corriere.get('https://api.example.com/users/1', {
  schema: UserSchema, // Throws validation errors early if fields mismatch
});
```

### 9. Download Progress Tracking 📊

Monitor response payload download progress in real time using the `onDownloadProgress` callback. The callback receives `{ loaded, total }`, both byte counts; `total` is `0` when the server sends no `content-length`:

```typescript
const response = await corriere.get('https://api.example.com/large-dataset.json', {
  onDownloadProgress: ({ loaded, total }) => {
    const pct = total > 0 ? `${Math.round((loaded / total) * 100)}%` : 'unknown';
    console.log(`Downloaded ${loaded} of ${total || '?'} bytes (${pct})`);
  },
});
```

> Progress is reported while Corriere reads the body for you. With `responseType: 'stream'`
> the body is handed to you unread, so `onDownloadProgress` is not called — count the bytes
> as you consume the stream instead.

---

## Configuration API ⚙️

Every option below can be set per call, or once on an instance with `corriere.create({...})`;
a per-call value wins. `headers`, `params` and `hooks` are merged key by key rather than
replaced.

### Request

| Option              | Type                        | Default         | Description                                                                                                                                                                                             |
| ------------------- | --------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`               | `string`                    | —               | Request URL, resolved against `baseURL` when relative.                                                                                                                                                  |
| `method`            | `string`                    | `'get'`         | HTTP method (case-insensitive).                                                                                                                                                                         |
| `baseURL`           | `string`                    | `undefined`     | Prefix for relative URLs.                                                                                                                                                                               |
| `allowAbsoluteUrls` | `boolean`                   | `false`         | Whether an absolute `url` may point outside `baseURL`. By default an absolute `url` must be on the same origin and under the base path; any other is rejected. Set `true` to let it override `baseURL`. |
| `params`            | `object \| URLSearchParams` | `undefined`     | Query parameters. Values also fill `:name` or `{name}` placeholders in the path (URL-encoded); the rest go in the query string.                                                                         |
| `paramsSerializer`  | `(params) => string`        | built in        | Custom query-string serializer. The built-in one writes nested objects as `a[b]=1`, arrays as repeated keys (`a=1&a=2`) and dates as ISO strings.                                                       |
| `data`              | `unknown`                   | `undefined`     | Request body. Plain objects are sent as JSON; `FormData`, `URLSearchParams`, `Blob`, `ArrayBuffer`, streams and strings are sent as they are. Ignored for `GET`, `HEAD` and `OPTIONS`.                  |
| `headers`           | `CorriereHeaders`           | see below       | Request headers. Flat headers and per-method groups (`common`, `get`, `post`, …) can be mixed; `undefined` values are omitted. `post`/`put`/`patch` default to `Content-Type: application/json`.        |
| `auth`              | `{ username, password }`    | `undefined`     | Sends an HTTP Basic `Authorization` header.                                                                                                                                                             |
| `withCredentials`   | `boolean`                   | `false`         | Sends cookies cross-origin (`credentials: 'include'`).                                                                                                                                                  |
| `signal`            | `AbortSignal`               | `undefined`     | Cancels the request; the error has code `ERR_CANCELED`.                                                                                                                                                 |
| `timeout`           | `number`                    | `0`             | Milliseconds before the request fails with `ETIMEDOUT`.`0` or `Infinity` disables it.                                                                                                                   |
| `transformRequest`  | `fn \| fn[]`                | JSON serializer | Functions `(data, headers, config)` applied to the body before sending.                                                                                                                                 |

### Response

| Option               | Type                                                      | Default     | Description                                                                                                                     |
| -------------------- | --------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `responseType`       | `'json' \| 'text' \| 'blob' \| 'arraybuffer' \| 'stream'` | `'json'`    | How the body is read. `'json'` parses the body as JSON when it is JSON, and returns it as text otherwise.                       |
| `validateStatus`     | `(status) => boolean \| null`                             | `2xx`       | Which statuses resolve; anything else rejects. `null` resolves every status.                                                    |
| `transformResponse`  | `fn \| fn[]`                                              | JSON parser | Functions `(data, headers, config)` applied to the response data.                                                               |
| `schema`             | `SchemaValidator`                                         | `undefined` | Anything with `.parse()` or `.parseAsync()` (Zod, Valibot, …), run on the data of an accepted response.                         |
| `maxContentLength`   | `number`                                                  | `undefined` | Largest response body in bytes; bigger ones fail with `ERR_BAD_RESPONSE`.                                                       |
| `onDownloadProgress` | `(e: DownloadProgressEvent) => void`                      | `undefined` | Called with `{ loaded, total }` as the body is read. Not called for `responseType: 'stream'`.                                   |
| `sseEvents`          | `boolean`                                                 | `false`     | For `stream()` on a `text/event-stream` response, yields each event as `{ event, data, id?, retry? }` instead of just its data. |

### Retries

| Option           | Type                               | Default                 | Description                                                                                                                                                                                                  |
| ---------------- | ---------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `retry`          | `number`                           | `0`                     | Number of times to retry failed requests. Network errors, timeouts and 5xx are retried by default, for the methods in `retryMethods`; cancellations never are.                                               |
| `retryMethods`   | `string[]`                         | `DEFAULT_RETRY_METHODS` | Methods that may be retried after a network error, timeout or 5xx. Defaults to the idempotent `get`, `head`, `options`, `put` and `delete`; add `post` or `patch` only if the server handles repeats safely. |
| `retryDelay`     | `number`                           | `1000`                  | Base delay in milliseconds; it doubles on each attempt, with jitter.                                                                                                                                         |
| `maxRetryDelay`  | `number`                           | `30000`                 | Cap on any single retry delay.                                                                                                                                                                               |
| `retryOn429`     | `boolean`                          | `false`                 | Retries HTTP 429 up to 3 times, even when `retry` is `0`. A `Retry-After` header on a 429 or 503 replaces the backoff delay.                                                                                 |
| `retryCondition` | `(error) => boolean`               | built in                | Decides whether a failure is retried, replacing the built-in rule above.                                                                                                                                     |
| `onRetry`        | `(attempt, error, config) => void` | `undefined`             | Called before each retry. An error it throws is ignored.                                                                                                                                                     |

### Caching and deduplication

| Option               | Type                               | Default  | Description                                                                                                                                              |
| -------------------- | ---------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cache`              | `boolean \| CacheProvider`         | `false`  | Caches successful `GET` responses in the instance's memory cache, or in the provider you pass.                                                           |
| `cacheTTL`           | `number`                           | `300000` | Milliseconds a response stays cached. `0` disables caching for that call.                                                                                |
| `cacheClone`         | `boolean`                          | `true`   | Hands each caller its own copy of cached or deduplicated data. `false` shares one object, which is faster but lets one caller's mutations reach another. |
| `cacheKeySerializer` | `(config, url, headers) => string` | built in | Custom cache key. The built-in key hashes the headers; a custom one must keep secrets out of the key itself.                                             |
| `dedupe`             | `boolean`                          | `false`  | Collapses identical concurrent `GET` requests into one network call.                                                                                     |

### Security and limits

| Option             | Type               | Default               | Description                                                                                                                                                                                                                                                     |
| ------------------ | ------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowedProtocols` | `string[] \| null` | `['http:', 'https:']` | URL schemes a request may use. `null` disables the check.                                                                                                                                                                                                       |
| `maxRedirects`     | `number`           | `undefined`           | Max redirects to follow. Leave unset to let `fetch` follow them. Setting it switches to manual following, which re-checks `allowedProtocols` on every hop and drops credentials across origins — but is unsupported in browsers, which return opaque redirects. |
| `rateLimiter`      | `RateLimiter`      | `undefined`           | A limiter from `createRateLimiter(maxConcurrent, maxQueueSize)`, shared by every request that uses it.                                                                                                                                                          |

### Pagination and forms

| Option                 | Type                        | Default               | Description                                                                                                                                                                          |
| ---------------------- | --------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `paginateItems`        | `string \| (data) => any[]` | see description       | Where `autoPaginate` finds each page's items: a property name or a function. By default, a page that is an array is used as is, otherwise its `data`, `items` or `results` property. |
| `maxPages`             | `number`                    | `1000`                | Most pages `autoPaginate` will fetch before failing.                                                                                                                                 |
| `allowedPaginateHosts` | `string[] \| null`          | `undefined`           | Extra hosts an `autoPaginate` `next` link may point to. Cross-origin links are refused by default; `null` disables the check. Credentials are dropped on any cross-origin hop.       |
| `formSerializer`       | `{ brackets?: boolean }`    | `{ brackets: false }` | How `postForm`/`putForm`/`patchForm` name nested fields: `a.b` by default, `a[b]` with `brackets: true`.                                                                             |

### Transport, hooks and debugging

| Option       | Type            | Default        | Description                                                                                                                                                           |
| ------------ | --------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch`      | `typeof fetch`  | global `fetch` | The `fetch` implementation to use.                                                                                                                                    |
| `dispatcher` | `unknown`       | `undefined`    | Passed through to `fetch` (an undici `Dispatcher` in Node, for proxies and connection pools).                                                                         |
| `agent`      | `unknown`       | `undefined`    | Passed through to `fetch` for implementations that accept an HTTP agent.                                                                                              |
| `hooks`      | `CorriereHooks` | `undefined`    | `onBeforeRequest(config)`, `onRequestResponse(response)` and `onRequestError(error)`, called by the request pipeline. An error thrown by `onRequestError` is ignored. |
| `debug`      | `boolean`       | `false`        | Logs each request, response and failure to the console, with credentials redacted.                                                                                    |

---

## TypeScript 🔷

Corriere is written in TypeScript and ships its types.
- `corriere` and every `corriere.create()` instance are fully typed (`CorriereInstance`).
  Pass the expected data type to any method: `corriere.get<User>('/users/1')` returns
  `Promise<CorriereResponse<User>>`.
- Request interceptors receive a `CorriereRequestConfig` and must return one (or a promise
  of one). Response interceptors receive a `CorriereResponse`; whatever they return is what
  the call resolves with.
- `corriere.isCorriereError(value)` and `corriere.isCancel(value)` are type guards that
  narrow an unknown `catch` value to `CorriereError`.
- The package exports only its root (`'corriere'`); internal modules are not importable.
  Everything public — the client, `CorriereError`, `createRateLimiter`, `MemoryCache`,
  `DEFAULT_RETRY_METHODS` and the types — comes from there.

---

## Security Notes 🔐

- **Redirects and the protocol allow-list.** `allowedProtocols` is checked on the URL you
  request. Intermediate redirect hops are re-checked only when `maxRedirects` is set — that
  is what switches Corriere to following redirects itself. Left unset, `fetch` follows them
  and Corriere never sees the intermediate URLs.
- **Pagination.** `autoPaginate` follows a `next` link chosen by the server it is
  paginating. Cross-origin links are refused unless you list the host in
  `allowedPaginateHosts`, and credentials (`Authorization`, `Cookie`,
  `Proxy-Authorization`, `auth`, `withCredentials`) are dropped on any cross-origin hop —
  including ones set on the instance or added by a request interceptor — and stay dropped
  for the rest of the chain.
- **Errors are safe to log.** Both `error.config` and `error.response.config` are redacted.
  A _successful_ `response.config` is not — callers legitimately read back what they sent —
  so avoid logging whole successful responses if they carry credentials.
- **Requests stay under `baseURL`.** On a client with a `baseURL`, an absolute `url` is sent
  only if it is on the same origin and under the base path; `client.get('https://elsewhere.example')`
  is rejected with `ERR_BAD_OPTION`, and `//host` is treated as a path under `baseURL`. So
  input that reaches `url` cannot send the request to another host. Set
  `allowAbsoluteUrls: true` to let absolute URLs override `baseURL`. `autoPaginate` may
  still follow an absolute `next` link; `allowedPaginateHosts` governs where it can go.
- **Retries and non-idempotent requests.** With `retry` set, a network error, timeout or 5xx
  is retried only for the idempotent methods in `DEFAULT_RETRY_METHODS` (`get`, `head`,
  `options`, `put`, `delete`). `POST` and `PATCH` are not retried, since the server may
  already have applied the first attempt; list them in `retryMethods` if repeats are safe.
  A `429` is retried for any method, since the server did not process it.
- **Unparseable JSON.** When a body labelled JSON fails to parse, the error message states
  only the position and length, never the body. The raw body is on `error.response.data`.
- **Cache keys.** The header portion of a cache key is hashed, so a `CacheProvider` never
  receives a token as a key. A custom `cacheKeySerializer` takes on that responsibility
  itself.

---

## Error Handling 🛡️

Errors thrown by Corriere are instances of `CorriereError` which carry metadata about the request and response, with automatic redaction of sensitive parameters (such as `api_key` or `password`) and headers (such as `authorization`, `proxy-authorization`, `cookie`, `x-api-key`, `api-key`, `x-auth-token`, `x-access-token`, `x-csrf-token` and `x-xsrf-token`). The same redaction is applied to structured debug logs, so sensitive URLs, query parameters, and request bodies are never printed in plaintext:

```typescript
import corriere from 'corriere';

try {
  await corriere.get('/invalid-endpoint');
} catch (error) {
  if (corriere.isCorriereError(error)) {
    console.error('Status Code:', error.response?.status);
    console.error('Error Code:', error.code);
    console.error('Request URL:', error.config?.url); // Redacted query params
    console.error('Request Headers:', error.config?.headers); // Redacted sensitive headers
  }
}
```

---

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📜 Changelog

Detailed release history and version changes can be found in [CHANGELOG.md](CHANGELOG.md).

## 🔐 Security

If you discover a security vulnerability, please see our [Security Policy](SECURITY.md).

## 📝 License

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.

---

**Author**: [Salvatore Corvaglia](https://github.com/salvatorecorvaglia)
