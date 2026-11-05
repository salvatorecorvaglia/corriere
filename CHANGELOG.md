# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-11-04

### Added

- Add a real-browser Playwright suite for Chromium, Firefox, and WebKit, covering distributed ESM loading without Node globals, native requests/forms, redirects, caching/deduplication, streaming, BYOB capability, pagination, timeouts, cancellation, and redaction. Run it in a dedicated CI job alongside the existing jsdom suite.
- Add isolated installed-tarball ESM/CJS runtime and declaration checks, a pinned publint check, and repeatable CPU benchmarks with JSON output and baseline comparisons.
- Add `pnpm test:integration` to build the package and exercise native Node Fetch against a local HTTP server, covering streamed uploads, cancellation and timeout handling after headers, redirect cleanup, and stream line limits.

### Changed

- Extract cache identity, registry ownership, inflight subscriptions, response caching, and response processing from the dispatcher into focused private modules. Centralize credential-header policy and enable strict property initialization and switch fallthrough checks.
- Enforce `retryMethods` for 429 responses and custom retry conditions. POST and PATCH require explicit inclusion even with `retryOn429: true`.
- Reject invalid retry counts, backoff durations, method lists, and pagination page limits before transport; require finite timer-safe delays and safe integer count limits.
- Include every explicit request header as unambiguous canonical tuples in built-in cache and deduplication identities, reusing normalized request headers. Keys now use `v4`; older entries are ignored and may expire normally. Custom key serializers remain unchanged.
- Apply deduplicated callers' cache policies independently, sharing raw snapshots and coalescing writes only for the same provider, key, TTL, and payload-cloning option while preserving independent caller responses. Different TTLs targeting one provider/key produce separate writes; the provider's write ordering determines the final entry and expiry.
- Refresh development dependencies and pnpm workspace dependency policies.
- Enable protective defaults: a 64 MiB estimated MemoryCache payload budget, 1 MiB stream line limit, and 8 MiB SSE event limit. Configure the cache with `new MemoryCache(maxItems, maxBytes)` and stream parsers with `maxStreamLineBytes` / `maxStreamEventBytes`; `Infinity` opts out.
- Bound debug payload traversal and previews, avoid getters and custom serialization methods, cap logged metadata strings, and omit whole-object response size estimation.
- Distinguish cached response entries, unsettled responses, and finalized responses in the internal request pipeline. Type subscriber rejections as unknown, remove unsafe response casts and inflight-record assertions, and preserve public cache-provider signatures and generated declarations.
- Separate request preparation from sharing, transport, and response processing. Prepare each caller once per attempt before cache lookup or deduplication, including cache hits and deduplicated subscribers. Synchronous invalidation still requires final URL and header values when hooks or transforms modify them.
- Resolve manual publication refs to immutable commits and publish the exact CI-tested tarball. Both release paths verify checksums, source commit, and a single tarball before publishing without lifecycle scripts.
- Pin external GitHub Actions to verified commit SHAs, use immutable CI checkout refs, disable persisted checkout credentials, and restrict OIDC and repository write permissions to the jobs that need them.
- Replace the rate limiter's array queue with a doubly linked FIFO queue: enqueue, dequeue, and queued cancellation removal are constant-time; destruction is linear. Preserve concurrency limits, queue limits, public counters, cancellation errors, and destroy behavior.

### Fixed

- Resolve pagination links against the effective page URL, including redirected pages, while retaining the original request origin for host checks and credential stripping. Track transport URLs without rerunning parameter serializers; validate next links and detect repeated effective pages and link targets.
- Keep exponential retry backoffs finite at large attempt counts, preserve unknown rejection values, and prevent custom conditions from retrying cancellation.
- Observe native Web Stream completion, errors, and cancellation at the source boundary so piping, teeing, readers, and async iteration release timeout wiring without patched public methods. Preserve BYOB support through response-size wrappers and release source-reader locks on completion.
- Cancel source readers when progress callbacks fail, preserving the original error if cancellation also fails. Release timeout and caller-abort wiring exactly once even when a streamed body remains unread.
- Clone response header arrays for cache snapshots, cache hits, and deduplicated deliveries, including when payload cloning is disabled.
- Populate each dedupe subscriber's cache after its own transforms and status checks succeed, even when the first subscriber disables caching or rejects the response. Isolate cache-provider failures to subscribers using the same write policy.
- Isolate request headers, parameters, hooks, auth, and form options from mutable defaults; preserve opaque transport, schema, and cache-provider identities.
- Honor case-insensitive inherited header removal with `undefined`, including method groups, without reviving lower-priority headers.
- Redact opaque string request bodies, nested parameter arrays, bracketed query keys, and URLs in validation and pagination-cycle errors. Keep debug logging failures from changing request outcomes.
- Track cache accounting across eviction, expiration, updates, deletion, and clear; skip oversized or unmeasurable values and cancel stream readers when parser budgets are exceeded.
- Separate response-size, redirect, and protocol policies in built-in sharing keys, including inflight isolation with custom keys. Bypass deduplication for download-progress observers so every caller receives its own events.
- Resolve templated base URL paths before checking the final request boundary, preserving valid base templates without invoking custom parameter serializers twice.
- Resolve and validate URLs after before-request hooks and request transforms, honoring their URL, base URL, and parameter changes for transport, logging, retries, and cache identity. Ignore stale internal prebuilt URLs.
- Compute cache and deduplication identities after request header transforms and transport header rules; prevent transforms from reattaching credentials on cross-origin pagination requests.
- Cancel discarded redirect bodies on rejected hops as well as followed hops, preserving redirect failures when cancellation fails and keeping returned bodies readable.
- Unregister stream finalizers during deterministic cleanup, with idempotent cleanup callbacks created outside the stream wrapper scope to avoid retaining their targets.
- Guard circular arrays as well as objects during query serialization, skipping cycles while retaining shared references and noncyclic values.
- Parse SSE CR, LF, and CRLF terminators across arbitrary chunk boundaries. Scan each decoded chunk once instead of rescanning unfinished lines, preserving UTF-8 decoding and early stream cleanup.
- Reject request interceptor predicate errors through the promise chain, including response error interceptors and recovery, instead of throwing synchronously.
- Clone mutable binary response data for cached and deduplicated callers while preserving ArrayBuffer, typed-array, DataView, and Buffer types. `cacheClone: false` retains shared storage.
- Bypass caching and deduplication for requests whose fetch, dispatcher, or agent differs from the transport captured at client creation, preventing response sharing across per-call transports.
- Prevent pagination next-link query keys from being reintroduced by instance defaults, preserving other parameters and supporting custom serializers without mutating caller configs.
- Preserve cancellation and timeout error codes when buffered response-body reads fail, allowing timeout retries and cancellation detection to work after headers arrive.
- Reject pre-aborted requests before cache access or dispatch, and recheck cancellation after asynchronous setup. Abort deduplicated work when setup cancellation leaves no subscribers.
- Set `duplex: 'half'` for streamed request bodies so native Node Fetch accepts uploads.
- Release original response streams when status checks, transforms, schemas, or response hooks reject; clear timeout wiring for bodyless stream responses.
- Keep raw error configs and responses in runtime-private fields so Node inspection does not expose request credentials, including through nested CorriereError causes.
- Validate the final request URL against `baseURL` after joining and path substitution, blocking relative and encoded dot-segment escapes. `allowAbsoluteUrls: true` retains the explicit opt-out.
- Redact sensitive query parameters and inline passwords in base-boundary error messages.

## [1.2.0] - 2026-10-28

### Changed

- Updated development dependencies, including Biome 2.6.3, TypeScript 6.0.3, tsup 9, and Vitest 5.0.5.
- Made CI reusable and required its quality checks before creating GitHub releases.
- Added npm package build, packing, entry-point verification, and metadata checks to CI.
- Limited browser and coverage tests to Node.js 22 in CI, while retaining unit tests across the Node.js matrix.
- Configured CI to cancel superseded runs on the same ref.
- Run the full reusable CI workflow against the selected ref before manual npm publication.
- Refresh the project logo and contributor, security and usage documentation.

## [1.1.0] - 2026-10-11

### Added

- `allowAbsoluteUrls` to explicitly permit request URLs outside an instance's `baseURL`.
- `retryMethods` and the exported `DEFAULT_RETRY_METHODS` constant to control which HTTP methods may be retried.
- `sseEvents` and the `ServerSentEvent` type to expose event names, data, IDs, and retry values when streaming Server-Sent Events.
- TypeScript types for callable clients, static helpers, grouped request headers, and request/response interceptors, plus type guards for `isCancel()` and `isCorriereError()`.

### Changed

- **Breaking:** Requests with a `baseURL` now reject absolute URLs outside its origin or base path by default. Set `allowAbsoluteUrls: true` to allow them.
- **Breaking:** Default retries for network errors, timeouts, and 5xx responses now apply only to idempotent methods. Add `post` or `patch` to `retryMethods` when repeating those requests is safe.
- **Breaking:** Removed internal package subpath exports. Import public APIs from `corriere` instead of `corriere/core/*`, `corriere/helpers/*`, or other internal paths.
- Streaming now parses Server-Sent Events by event boundaries, joins multiline data, and skips metadata, comments, and `[DONE]` events in the default data-only mode.
- Expanded the configuration reference, TypeScript examples, and security documentation.
- Updated development dependencies and pinned GitHub Actions runners to Ubuntu 24.04.

### Fixed

- Cached and deduplicated responses now apply each caller's own response transforms, status validation, and schema. Streams are excluded from caching and deduplication, and cached failures are not retried.
- Cross-origin pagination now strips credentials from instance defaults and request interceptors, and keeps them stripped for subsequent pages. Pagination options honor instance defaults.
- Request interceptor execution now honors `runWhen` and synchronous handlers, with consistent error propagation and recovery.
- Stream cleanup, cancellation, download progress, and response size enforcement.
- Binary and multipart request body handling, including `FormData` conversion.
- Sensitive configuration redaction in error responses and debug logs, including safe handling of malformed URL encoding and invalid JSON error messages.
- Memory cache expiration and rate limiter queue handling.
- Package builds and verification for the public ESM and CommonJS entry points.

## [1.0.0] - 2026-09-23

### Added

- First implementation of Corriere.
