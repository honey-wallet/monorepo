/** Local Bitcoin Core acceptance. Only public test phrase and regtest coins. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'honey-bitcoin-client-'));
const [bitcoind, output = path.join(work, 'evidence.json')] = process.argv.slice(2);
assert(bitcoind, 'Pass an explicit Bitcoin Core 31.1 bitcoind path');
const paths = [
  'packages/keyring/src/bunk.ts',
  'packages/keyring/src/bunk-bitcoin.ts',
  'packages/keyring/src/bunk-bitcoin.test.ts',
  'packages/keyring/src/bunk-bitcoin-discovery.ts',
  'packages/keyring/src/bunk-bitcoin-discovery.test.ts',
  'packages/keyring/src/bunk-bitcoin-history.ts',
  'packages/keyring/src/bunk-bitcoin-history.test.ts',
  'packages/keyring/src/bunk-bitcoin-fees.ts',
  'packages/keyring/src/bunk-bitcoin-fees.test.ts',
  'packages/keyring/src/bunk-bitcoin-rpc.ts',
  'packages/keyring/src/bunk-bitcoin-observe.ts',
  'packages/keyring/src/bunk-bitcoin-observe.test.ts',
  'packages/keyring/tests/fixtures/bunk-bitcoin-client.mjs',
  'packages/keyring/scripts/bunk-bitcoin-regtest.mjs',
  'packages/keyring/scripts/bunk-bitcoin-regtest.py',
  'packages/keyring/package.json',
  'pnpm-lock.yaml',
];
const sha = (data) => createHash('sha256').update(data).digest('hex');
// The approval coordinator also imports the durable journal. Freeze all keyring
// TypeScript sources, including its shared journal dependencies and tests.
paths.push(
  ...fs
    .readdirSync(path.join(repo, 'packages/keyring/src'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `packages/keyring/src/${name}`),
);
const hashes = () =>
  Object.fromEntries(paths.map((p) => [p, sha(fs.readFileSync(path.join(repo, p)))]));
const before = hashes();
const keyringRequire = createRequire(path.join(repo, 'packages/keyring/package.json'));
const require = createRequire(keyringRequire.resolve('vitest/package.json'));
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
await build({
  configFile: false,
  root: repo,
  publicDir: false,
  logLevel: 'silent',
  build: {
    outDir: path.join(work, 'dist'),
    emptyOutDir: true,
    minify: false,
    target: 'es2022',
    lib: {
      entry: path.join(repo, 'packages/keyring/tests/fixtures/bunk-bitcoin-client.mjs'),
      formats: ['es'],
      fileName: () => 'probe.mjs',
    },
  },
});
const bundle = path.join(work, 'dist/probe.mjs'),
  bundleHash = sha(fs.readFileSync(bundle));
const report = path.join(work, 'regtest.json');
const child = spawn(
  'python3',
  [
    path.join(repo, 'packages/keyring/scripts/bunk-bitcoin-regtest.py'),
    '--bitcoind',
    bitcoind,
    '--client-bundle',
    bundle,
    '--output',
    report,
  ],
  { cwd: repo, stdio: 'inherit' },
);
const code = await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('exit', resolve);
});
assert.equal(code, 0, 'regtest acceptance failed');
assert.deepEqual(hashes(), before, 'sources changed during acceptance');
assert.equal(sha(fs.readFileSync(bundle)), bundleHash, 'bundle changed');
const evidence = JSON.parse(fs.readFileSync(report, 'utf8'));
evidence.sourcesSha256 = before;
evidence.sourcesRechecked = true;
evidence.bundleSha256 = bundleHash;
fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`Bitcoin regtest acceptance passed; evidence ${output}`);
