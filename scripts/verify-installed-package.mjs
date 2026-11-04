import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'corriere-package-'));
const run = (command, args, cwd = temporary) =>
  execFileSync(command, args, { cwd, stdio: 'inherit', timeout: 60_000 });
try {
  const arguments_ = process.argv.slice(2).filter((argument) => argument !== '--');
  if (arguments_.length > 1) throw new Error('Supply at most one tarball path');
  const supplied = arguments_[0];
  let tarball;
  if (supplied) tarball = resolve(supplied);
  else {
    run('pnpm', ['pack', '--pack-destination', temporary], root);
    const packages = readdirSync(temporary).filter((name) => name.endsWith('.tgz'));
    if (packages.length !== 1) throw new Error('Expected exactly one packed tarball');
    tarball = join(temporary, packages[0]);
  }
  writeFileSync(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', [
    'install',
    '--cache',
    join(temporary, 'npm-cache'),
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    tarball,
  ]);
  writeFileSync(
    join(temporary, 'consumer.mjs'),
    `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import esm, { MemoryCache } from 'corriere';
const require = createRequire(import.meta.url);
const cjsModule = require('corriere');
for (const [label, api] of [['esm', esm], ['cjs', cjsModule.default]]) {
  let calls = 0;
  let release;
  let gate = Promise.resolve();
  const fetch = async () => { calls++; await gate; return new Response('{"value":1}', { headers: [['content-type', 'application/json'], ['set-cookie', 'a=1'], ['set-cookie', 'b=2']] }); };
  const client = api.create({ fetch, cache: true, dedupe: true });
  const first = await client('https://consumer.test/data');
  first.data.value = 99;
  first.headers['set-cookie'].push('injected=1');
  const cached = await client.get('https://consumer.test/data');
  assert.equal(calls, 1);
  assert.equal(cached.data.value, 1);
  assert.deepEqual(cached.headers['set-cookie'], ['a=1', 'b=2']);
  client.invalidate('https://consumer.test/data');
  await client.get('https://consumer.test/data');
  assert.equal(calls, 2);
  const provider = new MemoryCache();
  gate = new Promise(resolve => { release = resolve; });
  const pending = Promise.all([
    client.get('https://consumer.test/shared', { cache: false }),
    client.get('https://consumer.test/shared', { cache: provider }),
  ]);
  await new Promise(resolve => setImmediate(resolve));
  release();
  await pending;
  await client.get('https://consumer.test/shared', { cache: provider });
  assert.equal(calls, 3);
  await assert.rejects(client.get('https://consumer.test/data', { signal: AbortSignal.abort() }), error => api.isCancel(error));
  await assert.rejects(client.get('https://consumer.test/data', { retry: NaN }), { code: 'ERR_BAD_OPTION_VALUE' });
  console.log(label + ': installed requests, cache/dedupe, invalidation and cancellation passed');
}
for (const path of ['core/request', 'core/cacheIdentity', 'core/responseCache', 'src/index.ts', 'esm/index.js']) {
  assert.throws(() => require.resolve('corriere/' + path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
}
`,
  );
  run(process.execPath, ['consumer.mjs']);
  const types = `import corriere, { type CorriereInstance, type CorriereRequestConfig, MemoryCache } from 'corriere';
const config: CorriereRequestConfig = { headers: { common: { Authorization: undefined } }, retryMethods: ['get'], cache: new MemoryCache() };
const client: CorriereInstance = corriere.create(config);
const response: Promise<{ data: { ok: boolean } }> = client.get<{ ok: boolean }>('https://consumer.test');
void response;
`;
  writeFileSync(join(temporary, 'consumer.mts'), types);
  writeFileSync(join(temporary, 'consumer.cts'), types);
  run(join(root, 'node_modules', '.bin', 'tsc'), [
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    '--target',
    'ES2022',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--lib',
    'ES2022,DOM',
    'consumer.mts',
    'consumer.cts',
  ]);
  console.log('Installed ESM/CJS declaration checks passed.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
