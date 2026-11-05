# Contributing to Corriere 🚚

Thank you for your interest in contributing to **Corriere**! We welcome contributions, bug reports, feature requests, and security improvements from the community.

---

## Getting Started 🚀

### Prerequisites

Corriere uses **Node.js (>= 22.13.0)** and **pnpm** as its workspace package manager. Make sure you have the following installed:

- Node.js (v22 or v24 recommended)
- `pnpm` at the exact version in the `packageManager` field of [package.json](./package.json) (currently `12.16.1`)

### Setup Instructions

1. **Fork the Repository:** Fork the official [repository](https://github.com/salvatorecorvaglia/corriere) on GitHub and clone it locally:

   ```bash
   git clone https://github.com/YOUR_USERNAME/corriere.git
   cd corriere
   ```

2. **Install Dependencies:**

   ```bash
   pnpm install --frozen-lockfile
   ```

3. **Check the Build:**
   Validate that the build tooling works correctly:

   ```bash
   pnpm run build
   ```

---

## Development Workflow 🛠️

We use a modern toolchain for linting, formatting, type checking, and testing. Please ensure all these checks pass locally before submitting a Pull Request.

### Scripts Summary

| Command                      | Description                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run build`             | Compiles source files into CJS and ESM directories (`cjs/` and `esm/`) using `tsup`.                                                                                                                                                                                                                                                                                                          |
| `pnpm run lint`              | Runs `biome` to lint all TypeScript and configuration files.                                                                                                                                                                                                                                                                                                                                  |
| `pnpm run lint:fix`          | Runs `biome` and applies automated lint fixes.                                                                                                                                                                                                                                                                                                                                                |
| `pnpm run format`            | Runs `biome` to format the workspace files.                                                                                                                                                                                                                                                                                                                                                   |
| `pnpm run typecheck`         | Validates TypeScript compilation without emitting output (`tsc --noEmit`).                                                                                                                                                                                                                                                                                                                    |
| `pnpm test`                  | Runs the test suite in Node.js environment via `vitest`.                                                                                                                                                                                                                                                                                                                                      |
| `pnpm run test:watch`        | Runs the test suite in watch mode while you work.                                                                                                                                                                                                                                                                                                                                             |
| `pnpm run test:browser`      | Runs the test suite under jsdom. See the caveat in [vitest.browser.config.ts](./vitest.browser.config.ts): jsdom still runs on Node, so `Buffer` and `FinalizationRegistry` remain defined and every `typeof Buffer` guard takes its Node branch. Browser fallbacks are only genuinely exercised by tests that delete the global themselves — see [tests/auth.test.ts](./tests/auth.test.ts). |
| `pnpm run test:browser:real` | Builds the published ESM and tests native Fetch/Web Streams in Chromium, Firefox, and WebKit. Install browsers with `pnpm exec playwright install chromium firefox webkit` first.                                                                                                                                                                                                             |
| `pnpm run verify:installed`  | Packs and installs an isolated, offline consumer; checks ESM/CJS behavior, export boundaries, and both declaration formats. Requires a build; optionally pass a tarball path.                                                                                                                                                                                                                 |
| `pnpm run bench`             | Runs repeatable CPU benchmarks for plain requests, cache hits, and cached dedupe bursts. See [benchmarks/README.md](./benchmarks/README.md).                                                                                                                                                                                                                                                  |
| `pnpm run lint:package`      | Checks package metadata with the lockfile-pinned publint dependency.                                                                                                                                                                                                                                                                                                                          |
| `pnpm run test:coverage`     | Runs tests and enforces the coverage thresholds in [vitest.config.ts](./vitest.config.ts).                                                                                                                                                                                                                                                                                                    |
| `pnpm run verify:package`    | Validates build artifacts, subpath exports, and TypeScript declaration files. Requires `pnpm run build` first.                                                                                                                                                                                                                                                                                |

Run `pnpm run test:integration` to build the package and test native Fetch against a
local HTTP server. It covers streamed uploads, cancellation after response headers,
redirect cleanup, and stream limits. Run it when changing transport or stream handling;
it requires permission to listen on a loopback port. CI runs it across its Node matrix.
The separate real-browser job installs all three engines and runs `test:browser:real`;
the jsdom pass remains useful for the full unit suite but does not replace real browsers.

### Firefox validation on macOS

If the bundled Firefox exits before startup with `Could not find profile folder`, the
same tests can run against the built ESM in Playwright's Linux image. This was the
fallback used for the Phase 5 Firefox validation; Chromium and WebKit passed on macOS.
Build first and keep the image version matched to `@playwright/test`:

```sh
pnpm build
docker run --rm --init --network none --shm-size=256m \
  --mount type=bind,source="$PWD",target=/work,readonly \
  --workdir /work mcr.microsoft.com/playwright:v1.64.1-noble \
  node node_modules/@playwright/test/cli.js test --project=firefox \
  --workers=1 --output=/tmp/corriere-browser-results
```

The container uses its own loopback server and temporary browser profiles. CI provisions
all three engines on Linux and runs the complete real-browser suite.

### Adding Features or Bug Fixes

1. **Create a Branch:**
   Branch off from `main`. Use a descriptive name:

   ```bash
   git checkout -b feature/your-awesome-feature
   # or
   git checkout -b fix/some-bug
   ```

2. **Write Tests:**
   If you are fixing a bug or adding a feature, please write corresponding tests in the `tests/` directory. Corriere uses `vitest`. Make sure you cover edge cases and regression scenarios.

   Two conventions worth knowing:
   - **Name test files after the module they cover, not after the fix.** A test for `src/helpers/toFormData.ts` belongs in `tests/toFormData.test.ts`. The repository previously accumulated files named for _when_ a fix landed (`regression_fixes_v2`, `logicFixes`, …), which meant finding the test for a given behaviour required grepping all of them. Please do not start a new one.
   - **Prove the test would have caught the bug.** Before you commit a regression test, run the test against the code before your fix in a separate worktree and confirm it _fails_ — a test that passes against the unfixed code documents nothing. This is easy to get wrong: a 500 response resolves out of `fetch` and fails later per-subscriber, so reaching the code that handles a _rejected_ request means making `fetch` itself reject.

   Note that `dispatchRequest` is the bare pipeline — `defaults`, and with them `validateStatus`, are applied by `Corriere.request`. Tests that call `dispatchRequest` directly must supply `validateStatus` themselves or every status will resolve.

3. **Verify Code Quality:**
   Run the following commands to verify everything is healthy:

   ```bash
   pnpm run lint
   pnpm run typecheck
   pnpm test
   pnpm run test:browser
   pnpm run test:integration
   pnpm run test:browser:real
   pnpm run test:coverage
   pnpm run build && pnpm run verify:package
   pnpm run verify:installed
   pnpm run lint:package
   ```

   CI additionally runs `pnpm audit --audit-level=high`; run it locally if you touch dependencies.

   `test:coverage` enforces thresholds set just under the measured baseline. If your change legitimately moves coverage, re-baseline the thresholds in [vitest.config.ts](./vitest.config.ts) **in the same commit** that moves it — otherwise the floor drifts away from reality and stops catching regressions.

4. **Document Changes:**
   - If your change affects public APIs, update the [README.md](./README.md) with relevant details.
   - Summarize your changes under the `[Unreleased]` section in [CHANGELOG.md](./CHANGELOG.md) using the [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) standard.

### Security-Sensitive Areas 🔐

Some code paths exist specifically to keep credentials from escaping. Changes there deserve an explicit note in your PR description explaining why the guarantee still holds:

- **Redaction** (`src/core/corriereError.ts`) — both `error.config` and `error.response.config` are redacted because errors reach logs and crash reporters. A _successful_ `response.config` is deliberately left readable; that asymmetry is intentional, not an oversight.
- **Cache keys** (`buildCacheKey` in `src/core/cacheIdentity.ts`) — the header segment is hashed so a `CacheProvider` never receives a bearer token as the key it persists. A custom `cacheKeySerializer` takes on that obligation itself.
- **Cross-origin hops** (`src/core/fetchAdapter.ts`, `src/features/paginate.ts`) — redirect targets and pagination `next` links are both server-controlled URLs, and both drop `CREDENTIAL_HEADERS` when they cross origins.

---

## Dependencies 📦

Dependency updates belong in their own Pull Request, never bundled into a feature or fix.

**`--frozen-lockfile` will not save you here.** It fails when `package.json` and `pnpm-lock.yaml` _disagree_ — so a tool that rewrites both consistently (`pnpm update --latest` and friends) produces a state CI installs without complaint. A major version bump can reach the release workflow that way with nothing flagging it. After any dependency change, run the full verification list above and state in the PR which majors moved.

Direct dependency ranges and the pnpm version live in [package.json](./package.json).
Dependency overrides and build permissions live in [pnpm-workspace.yaml](./pnpm-workspace.yaml);
commit [pnpm-lock.yaml](./pnpm-lock.yaml) alongside dependency changes.

---

## Pull Request Guidelines 📬

When submitting a Pull Request, please ensure:

- The title follows the [Conventional Commits](https://www.conventionalcommits.org/) format (e.g. `feat: add retryDelay custom Jitter`, `fix: handle null headers in request`).
- The description clearly details the motivation, changes made, and references any relevant issues.
- You have updated the contributors list in [CONTRIBUTORS.md](./CONTRIBUTORS.md) if you are a new contributor!

---

Happy coding! 🚚
