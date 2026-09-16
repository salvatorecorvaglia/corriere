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
  role: 'Developer'
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
    'Authorization': 'Bearer YOUR_TOKEN'
  }
});

// Sends GET to https://api.example.com/v1/projects
const response = await client.get('/projects');
```

---

## Advanced Features 🛠️

### 1. Server-Sent Events & Streaming 🌊
Read streams line-by-line using `async generators`. Lines are split on `\n`, `data: …` prefixes are unwrapped, and each line is returned as parsed JSON when it parses and as a string otherwise:

```typescript
// Stream completions from an LLM endpoint
for await (const chunk of corriere.stream('https://api.example.com/chat/stream')) {
  console.log(chunk); // Parsed JSON chunk or raw text line
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
  cache: true,      // Enable caching
  cacheTTL: 60000,   // TTL in milliseconds (1 minute)
});
```

Entries expire after `cacheTTL` (5 minutes by default). Each client owns its cache, so two
instances never serve each other's responses — and you can clear it explicitly:

```typescript
const client = corriere.create({ baseURL: 'https://api.example.com' });

await client.get('/config', { cache: true });

client.invalidate('/config', { cache: true }); // drop one entry
client.clearCache();                           // drop everything
```

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
  corriere.get('https://api.example.com/profile', { dedupe: true })
]);
```

### 6. Rate Limiting 🚦
Control concurrent requests to protect client/server throughput constraints:

```typescript
import corriere, { createRateLimiter } from 'corriere';

// Allow maximum 3 concurrent requests, max queue size of 10
const limiter = createRateLimiter(3, 10);

const client = corriere.create({
  rateLimiter: limiter
});
```

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
  (error) => Promise.reject(error)
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
  }
);
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
  schema: UserSchema // Throws validation errors early if fields mismatch
});
```

### 9. Download Progress Tracking 📊
Monitor response payload download progress in real time using the `onDownloadProgress` callback. The callback receives `{ loaded, total }`, both byte counts; `total` is `0` when the server sends no `content-length`:

```typescript
const response = await corriere.get('https://api.example.com/large-dataset.json', {
  onDownloadProgress: ({ loaded, total }) => {
    const pct = total > 0 ? `${Math.round((loaded / total) * 100)}%` : 'unknown';
    console.log(`Downloaded ${loaded} of ${total || '?'} bytes (${pct})`);
  }
});
```

> Progress is reported while Corriere reads the body for you. With `responseType: 'stream'`
> the body is handed to you unread, so `onDownloadProgress` is not called — count the bytes
> as you consume the stream instead.

---

## Configuration API ⚙️

Here is a list of popular config parameters available on `CorriereRequestConfig`:

| Option | Type | Default | Description |
|---|---|---|---|
| `baseURL` | `string` | `undefined` | Prefixed URL for requests. |
| `timeout` | `number` | `0` | Request timeout in milliseconds (0 means disabled). |
| `headers` | `object` | `{}` | Key-value pairs for HTTP request headers. |
| `responseType`| `'json' \| 'text' \| 'blob' \| 'arraybuffer' \| 'stream'` | `'json'` | Data type expected back from the server. |
| `retry` | `number` | `0` | Number of times to retry failed requests. Network errors, timeouts and 5xx are retried by default; cancellations never are. |
| `retryDelay` | `number` | `1000` | Delay between retries in milliseconds. |
| `maxRetryDelay` | `number` | `30000` | Cap on exponential backoff delays. |
| `retryOn429` | `boolean` | `false` | Whether to automatically retry on HTTP 429 status code. |
| `dedupe` | `boolean` | `false` | Enable collapsing of identical concurrent GET requests. |
| `cache` | `boolean \| CacheProvider` | `false` | Enable in-memory caching of responses. |
| `cacheTTL` | `number` | `300000` | Duration (ms) a response stays cached. `0` disables caching for that call. |
| `allowedProtocols` | `string[]` | `undefined` | List of permitted URL protocols (e.g., `['https:']`). |
| `maxContentLength` | `number` | `undefined` | Max response size in bytes permitted (throws error early). |
| `maxRedirects` | `number` | `undefined` | Max redirects to follow. Leave unset to let `fetch` follow them. Setting it switches to manual following, which re-checks `allowedProtocols` on every hop and drops credentials across origins — but is unsupported in browsers, which return opaque redirects. |
| `onDownloadProgress` | `(e: DownloadProgressEvent) => void` | `undefined` | Called with `{ loaded, total }` as the body is read. Not called for `responseType: 'stream'`. |
| `allowedPaginateHosts` | `string[] \| null` | `undefined` | Extra hosts an `autoPaginate` `next` link may point to. Cross-origin links are refused by default; `null` disables the check. Credentials are dropped on any cross-origin hop. |
| `schema` | `SchemaValidator` | `undefined` | Schema to run `.parse()` or `.parseAsync()` against. |

---

## Security Notes 🔐

- **Redirects and the protocol allow-list.** `allowedProtocols` is checked on the URL you
  request. Intermediate redirect hops are re-checked only when `maxRedirects` is set — that
  is what switches Corriere to following redirects itself. Left unset, `fetch` follows them
  and Corriere never sees the intermediate URLs.
- **Pagination.** `autoPaginate` follows a `next` link chosen by the server it is
  paginating. Cross-origin links are refused unless you list the host in
  `allowedPaginateHosts`, and credentials (`Authorization`, `Cookie`,
  `Proxy-Authorization`, `auth`) are dropped on any cross-origin hop.
- **Errors are safe to log.** Both `error.config` and `error.response.config` are redacted.
  A *successful* `response.config` is not — callers legitimately read back what they sent —
  so avoid logging whole successful responses if they carry credentials.
- **Cache keys.** The header portion of a cache key is hashed, so a `CacheProvider` never
  receives a token as a key. A custom `cacheKeySerializer` takes on that responsibility
  itself.

---

## Error Handling 🛡️

Errors thrown by Corriere are instances of `CorriereError` which carry metadata about the request and response, with automatic redaction of sensitive parameters (such as `api_key` or `password`) and headers (such as `authorization`, `proxy-authorization`, `x-api-key`, and `api-key`). The same redaction is applied to structured debug logs, so sensitive URLs, query parameters, and request bodies are never printed in plaintext:

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