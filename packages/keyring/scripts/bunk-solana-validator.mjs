/** Isolated shared-client / actual-validator acceptance; public phrase only. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'honey-solana-client-'));
const output = process.argv[2] ?? path.join(work, 'evidence.json');
const paths = [
  ...new Set([
    ...fs
      .readdirSync(path.join(repo, 'packages/keyring/src'))
      .filter((n) => n.endsWith('.ts'))
      .map((n) => `packages/keyring/src/${n}`),
    'packages/keyring/src/bunk.ts',
    'packages/keyring/src/bunk-solana.ts',
    'packages/keyring/src/bunk-solana.test.ts',
    'packages/keyring/src/bunk-solana-observe.ts',
    'packages/keyring/src/bunk-solana-journal.ts',
    'packages/keyring/src/bunk-solana-journal.test.ts',
    'packages/keyring/src/bunk-evm-v2-journal.ts',
    'packages/keyring/src/bunk-evm-v2-store.ts',
    'packages/keyring/src/bunk-indexeddb-store.ts',
    'packages/keyring/src/bunk-journal-key.ts',
    'packages/keyring/src/fixtures/bunk-solana.json',
    'packages/keyring/scripts/bunk-solana-vectors.py',
    'packages/keyring/tests/fixtures/bunk-solana-client.mjs',
    'packages/keyring/scripts/bunk-solana-validator.mjs',
    'packages/keyring/package.json',
    'pnpm-lock.yaml',
  ]),
];
const sha = (data) => createHash('sha256').update(data).digest('hex');
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
    rollupOptions: { external: (id) => id.startsWith('node:') },
    outDir: path.join(work, 'dist'),
    emptyOutDir: true,
    minify: false,
    target: 'es2022',
    lib: {
      entry: path.join(repo, 'packages/keyring/tests/fixtures/bunk-solana-client.mjs'),
      formats: ['es'],
      fileName: () => 'probe.mjs',
    },
  },
});
const report = path.join(work, 'validator.json');
const child = spawn(
  'python3',
  [
    path.join(repo, 'packages/bunk-solana/scripts/validator.py'),
    '--client-bundle',
    path.join(work, 'dist/probe.mjs'),
    '--output',
    report,
  ],
  { cwd: repo, stdio: 'inherit' },
);
const code = await new Promise((resolve, reject) => {
  child.on('error', reject);
  child.on('exit', resolve);
});
assert.equal(code, 0, 'owned validator acceptance failed');
assert.deepEqual(hashes(), before, 'shared-client sources changed during acceptance');
const evidence = JSON.parse(fs.readFileSync(report, 'utf8'));
assert.equal(
  evidence.phraseClient.bundleSha256,
  sha(fs.readFileSync(path.join(work, 'dist/probe.mjs'))),
);
evidence.clientSourcesSha256 = before;
evidence.clientSourcesRechecked = true;
evidence.clientWorkDirectory = work;
fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`Shared Solana client acceptance passed; evidence ${output}`);
