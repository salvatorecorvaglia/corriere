import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// TypeScript 7 emits declarations without the compiler API used by tsup's
// declaration bundler. Preserve the declaration graph and make its relative
// references explicit for NodeNext consumers of both package entry points.
const root = fileURLToPath(new URL('..', import.meta.url));
const declarations = join(root, 'dist', 'types');
const require = createRequire(import.meta.url);
const compilerPackage = require.resolve('typescript/package.json');
const compiler = JSON.parse(await readFile(compilerPackage, 'utf8'));
await rm(declarations, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [join(dirname(compilerPackage), compiler.bin.tsc), '-p', 'tsconfig.build.json'],
  {
    cwd: root,
    stdio: 'inherit',
  },
);

async function emit(directory = '') {
  for (const entry of await readdir(join(declarations, directory), { withFileTypes: true })) {
    const relative = join(directory, entry.name);
    if (entry.isDirectory()) {
      await emit(relative);
      continue;
    }
    if (!entry.name.endsWith('.d.ts')) continue;
    const source = await readFile(join(declarations, relative), 'utf8');
    for (const [output, runtimeExtension, declarationExtension] of [
      ['esm', '.js', '.d.ts'],
      ['cjs', '.cjs', '.d.cts'],
    ]) {
      const content = source.replace(
        /((?:from\s*|import\s*\(\s*)['"])(\.{1,2}\/[^'"]+)(['"])/g,
        (_, prefix, specifier, suffix) =>
          `${prefix}${specifier.replace(/\.(?:[cm]?js|[cm]?ts)$/, '')}${runtimeExtension}${suffix}`,
      );
      const target = join(root, output, relative.replace(/\.d\.ts$/, declarationExtension));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
  }
}

await emit();
