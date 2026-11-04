import { readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const modulePath = process.argv
  .find((arg) => arg.startsWith('--module='))
  ?.slice('--module='.length);
const { default: corriere } = await import(
  modulePath
    ? pathToFileURL(resolve(modulePath)).href
    : new URL('../esm/index.js', import.meta.url).href
);

// CPU-side library workloads, with an in-process Fetch transport and no network latency.
// Run the same script/build/runtime before and after a change; timings are not CI gates.
const samples = 7;
const small = JSON.stringify({ ok: true, value: 'x'.repeat(128) });
const large = JSON.stringify(
  Array.from({ length: 256 }, (_, id) => ({ id, text: 'x'.repeat(1024) })),
);
const makeClient = (body, config = {}) =>
  corriere.create({
    ...config,
    fetch: async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
  });
const cases = [
  {
    name: 'plain-get-small',
    operations: 500,
    setup: () => makeClient(small),
    run: (client, i) => client.get(`https://bench.test/${i}`),
  },
  {
    name: 'cache-hit-small',
    operations: 1000,
    setup: async () => {
      const client = makeClient(small, { cache: true });
      await client.get('https://bench.test/cache');
      return client;
    },
    run: (client) => client.get('https://bench.test/cache'),
  },
  {
    name: 'cache-hit-large',
    operations: 100,
    setup: async () => {
      const client = makeClient(large, { cache: true });
      await client.get('https://bench.test/cache');
      return client;
    },
    run: (client) => client.get('https://bench.test/cache'),
  },
  {
    name: 'dedupe-cache-large-16',
    operations: 128,
    batch: 16,
    setup: () => makeClient(large, { cache: true, dedupe: true }),
    run: (client, i) =>
      Promise.all(Array.from({ length: 16 }, () => client.get(`https://bench.test/${i}`))),
  },
];
const results = [];
for (const workload of cases) {
  const timings = [];
  for (let sample = -1; sample < samples; sample++) {
    const client = await workload.setup();
    globalThis.gc?.();
    const start = performance.now();
    for (let i = 0; i < workload.operations / (workload.batch ?? 1); i++)
      await workload.run(client, i);
    const elapsed = performance.now() - start;
    if (sample >= 0) timings.push(elapsed / workload.operations);
  }
  timings.sort((a, b) => a - b);
  results.push({
    name: workload.name,
    operations: workload.operations,
    medianMsPerRequest: timings[Math.floor(samples / 2)],
    minMsPerRequest: timings[0],
    maxMsPerRequest: timings.at(-1),
  });
}
const report = {
  runtime: process.version,
  platform: `${platform()}-${arch()}`,
  cpu: cpus()[0]?.model,
  payloadBytes: { small: Buffer.byteLength(small), large: Buffer.byteLength(large) },
  samples,
  results,
};
const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice('--output='.length);
if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
const baselinePath = process.argv
  .find((arg) => arg.startsWith('--baseline='))
  ?.slice('--baseline='.length);
const baseline = baselinePath ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
for (const result of results) {
  const previous = baseline?.results.find((item) => item.name === result.name);
  const delta = previous
    ? ` (${((result.medianMsPerRequest / previous.medianMsPerRequest - 1) * 100).toFixed(1)}% vs baseline)`
    : '';
  console.log(`${result.name}: ${result.medianMsPerRequest.toFixed(4)} ms/request${delta}`);
}
