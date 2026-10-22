# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Updated development dependencies, including Biome 2.6.2, TypeScript 7, tsup 9, and Vitest 5.0.5.
- Made CI reusable and required its quality checks before creating GitHub releases.
- Added npm package build, packing, entry-point verification, and metadata checks to CI.
- Limited browser and coverage tests to Node.js 22 in CI, while retaining unit tests across the Node.js matrix.
- Configured CI to cancel superseded runs on the same ref.

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
