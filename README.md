<p align="center">
  <img src="resources/corriere.svg" alt="Corriere logo" width="96" height="96">
</p>

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

## Installation

Corriere requires Node.js **22.13.0 or newer**. It uses native `fetch` and Web APIs;
browser applications need an environment that provides those APIs. The package ships
ESM, CommonJS, and TypeScript declarations.

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

- When the response is `text/event-stream`, the body is parsed as Server-Sent Events with CR, LF, or CRLF line endings: each event yields its `data` (multi-line `data:` fields are joined with `\n`), `event:`/`id:`/`retry:`/comment lines are skipped, and a `[DONE]` event is dropped.
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

Stream parsers cap each decoded line at 1 MiB and each SSE event at 8 MiB by default.
Set `maxStreamLineBytes` and `maxStreamEventBytes` on a client or call to change them;
`Infinity` disables the respective limit. Limits count UTF-8 bytes; an SSE event counts
its nonblank lines plus one newline per line, including metadata and comments. Exceeding
a limit throws `ERR_BAD_RESPONSE` and releases the reader. Both options accept
non-negative safe integers or `Infinity`. `maxContentLength` separately limits the whole
response body.

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

When a pagination `next` link includes a query key, it replaces the matching initial or
instance-default parameter for the remaining chain. Other parameters, such as filters,
are preserved. Custom parameter serializers receive only the remaining parameters.
Relative links resolve against the current page's effective response URL, including
after redirects. Set `maxPages` to a positive safe integer to change the default limit of
1,000 pages.

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

`invalidate()` computes the key synchronously from the instance defaults and the config
you pass. Interceptors, hooks, and request transforms do not run. Supply the final URL,
params, and headers if those stages change them (for example, a transformed auth header).

The built-in `MemoryCache` defaults to 1,000 entries and a 64 MiB estimated payload budget.
To choose another budget, pass a cache instance:

```typescript
const client = corriere.create({ cache: new corriere.MemoryCache(1000, 16 * 1024 * 1024) });
```

The second constructor argument is the byte budget: `0` disables storage and `Infinity`
disables byte accounting. `estimatedBytes` reports the current accounting total (zero
when accounting is disabled). Oversized or unmeasurable entries are skipped without
failing the request. Estimates include keys, strings, object fields, binary backing
buffers, and collection entries; they exclude opaque transport handles and are not a
measurement of engine heap usage. Accounting is taken at insertion, so externally
mutating stored values does not recalculate it. Traversal is bounded to 10,000 nodes and
64 levels, with getters and custom serialization methods left unevaluated. An update
that no longer fits removes the older cached value.

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

Queued calls are admitted in FIFO order. Aborting a queued call immediately frees its
queue capacity. Queue insertion, admission, and cancellation removal take constant time;
`destroy()` rejects all pending calls in one pass.

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

If a request interceptor's `runWhen` predicate throws, the request rejects through its
promise. Response error interceptors can observe or recover from that failure, and the
transport is not called.

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
- **Requests stay under `baseURL`.** On a client with a `baseURL`, the final request URL is sent
  only if it is on the same origin and under the base path, after joining and substitution; `client.get('https://elsewhere.example')`
  is rejected with `ERR_BAD_OPTION`, and `//host` is treated as a path under `baseURL`. So
  input that reaches `url` cannot send the request to another host. Set
  `allowAbsoluteUrls: true` to permit requests outside that boundary, including relative
  dot-segment paths such as `../admin`. `autoPaginate` may
  still follow an absolute `next` link; `allowedPaginateHosts` governs where it can go.
- **Retries and non-idempotent requests.** With `retry` set, a network error, timeout or 5xx
  is retried only for the idempotent methods in `DEFAULT_RETRY_METHODS` (`get`, `head`,
  `options`, `put`, `delete`). `POST` and `PATCH` are not retried, since the server may
  already have applied the first attempt; list them in `retryMethods` if repeats are safe.
  The same method limits apply to `429` responses, including with `retryOn429: true`;
  a rate-limit response does not guarantee that a non-idempotent operation had no effect.
  `retry` must be a non-negative safe integer. `retryDelay` and `maxRetryDelay` must be
  finite durations from `0` to `2147483647` ms. Invalid values reject before transport.
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

## Contributing 🤝

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Changelog 📜

Detailed release history and version changes can be found in [CHANGELOG.md](CHANGELOG.md).

## Security 🔐

If you discover a security vulnerability, please see our [Security Policy](SECURITY.md).

## License 📝

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.

## Author ✍️

[Salvatore Corvaglia](https://github.com/salvatorecorvaglia)
