import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function collectEntries(dir: string, base: string = dir): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      Object.assign(entries, collectEntries(fullPath, base));
    } else if (entry.endsWith('.ts') && !entry.startsWith('types')) {
      const rel = relative(base, fullPath).replace(/\.ts$/, '');
      entries[rel] = fullPath;
    }
  }
  return entries;
}

const srcDir = join(__dirname, 'src');

/**
 * `bundle` MUST stay true.
 *
 * With `bundle: false` esbuild transpiles each file but leaves relative import specifiers
 * exactly as written in the source — extensionless. The emitted files are `.cjs`/`.js`, so
 * `require("./corriere")` could not resolve `corriere.cjs` and `import "./corriere"` failed
 * ESM resolution with ERR_MODULE_NOT_FOUND. Both published entry points failed to load at
 * all. Bundling resolves every specifier at build time, which sidesteps the mismatch.
 *
 * `splitting` keeps shared modules in common chunks so the multiple entry points declared
 * in package.json#exports do not each inline a private copy of the core.
 */
export default defineConfig([
  {
    entry: collectEntries(srcDir),
    format: ['cjs'],
    outDir: 'cjs',
    outExtension: () => ({ js: '.cjs' }),
    bundle: true,
    splitting: true,
    clean: true,
    dts: true,
    silent: false,
    target: 'node22',
    platform: 'node',
    noExternal: [],
    sourcemap: true,
  },
  {
    entry: collectEntries(srcDir),
    format: ['esm'],
    outDir: 'esm',
    outExtension: () => ({ js: '.js' }),
    bundle: true,
    splitting: true,
    clean: true,
    dts: true,
    silent: false,
    target: 'node22',
    platform: 'node',
    noExternal: [],
    sourcemap: true,
  },
]);
