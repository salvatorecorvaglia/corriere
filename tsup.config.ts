import { defineConfig } from 'tsup';

/**
 * One entry point: package.json#exports publishes only the package root, so `src/index.ts`
 * is the whole public surface and everything else is bundled into it. (Every source file
 * used to be its own entry, reachable through `corriere/core/*` and similar subpaths, which
 * made each internal module part of the semver contract.)
 *
 * `bundle` MUST stay true.
 *
 * With `bundle: false` esbuild transpiles each file but leaves relative import specifiers
 * exactly as written in the source — extensionless. The emitted files are `.cjs`/`.js`, so
 * `require("./corriere")` could not resolve `corriere.cjs` and `import "./corriere"` failed
 * ESM resolution with ERR_MODULE_NOT_FOUND. Both published entry points failed to load at
 * all. Bundling resolves every specifier at build time, which sidesteps the mismatch.
 */
const entry = { index: 'src/index.ts' };

export default defineConfig([
  {
    entry,
    format: ['cjs'],
    outDir: 'cjs',
    outExtension: () => ({ js: '.cjs' }),
    bundle: true,
    clean: true,
    dts: true,
    silent: false,
    target: 'node22',
    platform: 'node',
    noExternal: [],
    sourcemap: true,
  },
  {
    entry,
    format: ['esm'],
    outDir: 'esm',
    outExtension: () => ({ js: '.js' }),
    bundle: true,
    clean: true,
    dts: true,
    silent: false,
    target: 'node22',
    platform: 'node',
    noExternal: [],
    sourcemap: true,
  },
]);
