/** Isolated real-Chrome acceptance. Uses a fresh profile, public seed fixtures and
 * loopback assets only. Never attaches to the user's browser or enables Honey. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'honey-bunk-browser-'));
const profile = path.join(work, 'profile'),
  dist = path.join(work, 'dist');
const chrome =
  process.env.BUNK_TEST_CHROME ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome');
const output = process.argv[2] ?? path.join(work, 'evidence.json');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const paths = [
  ...fs
    .readdirSync(path.join(repo, 'packages/keyring/src'))
    .filter((n) => n.startsWith('bunk') && n.endsWith('.ts'))
    .map((n) => `packages/keyring/src/${n}`),
  'packages/keyring/src/index.ts',
  'packages/keyring/src/fixtures/bunk-evm-v3.json',
  'packages/keyring/src/fixtures/bunk-evm-v2.json',
  'packages/keyring/src/fixtures/bunk-journal-key.json',
  'packages/keyring/scripts/bunk-journal-key-vectors.py',
  'packages/keyring/package.json',
  'pnpm-lock.yaml',
  'packages/keyring/scripts/bunk-browser-journal.mjs',
  'packages/keyring/tests/fixtures/bunk-browser-probe.mjs',
];
const hashes = () =>
  Object.fromEntries(paths.map((p) => [p, sha(fs.readFileSync(path.join(repo, p)))]));
const before = hashes(),
  cases = [];
const keyringRequire = createRequire(path.join(repo, 'packages/keyring/package.json'));
const require = createRequire(keyringRequire.resolve('vitest/package.json'));
const { build } = await import(pathToFileURL(require.resolve('vite')).href);
await build({
  configFile: false,
  root: repo,
  publicDir: false,
  logLevel: 'silent',
  build: {
    outDir: dist,
    emptyOutDir: true,
    minify: false,
    target: 'es2022',
    lib: {
      entry: path.join(repo, 'packages/keyring/tests/fixtures/bunk-browser-probe.mjs'),
      formats: ['es'],
      fileName: () => 'probe.js',
    },
  },
});
const bundle = fs.readFileSync(path.join(dist, 'probe.js'));
const server = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; connect-src 'none'",
  );
  if (req.url === '/probe.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(bundle);
  } else if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<!doctype html><meta charset="utf-8"><title>Bunk isolated IndexedDB test</title><script type="module" src="/probe.js"></script>',
    );
  } else {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
let browser,
  sequence = 0,
  version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function launch() {
  const stderr = fs.openSync(path.join(work, `chrome-${++sequence}.log`), 'w');
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', stderr, 'pipe', 'pipe'] },
  );
  fs.closeSync(stderr);
  const pending = new Map();
  let id = 0,
    buffer = Buffer.alloc(0),
    ended = false;
  const exited = new Promise((resolve) => {
    child.once('error', (error) => {
      ended = true;
      resolve({ error: error.message });
    });
    child.on('exit', (code, signal) => {
      ended = true;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(Error(`Test browser exited: ${code}/${signal}`));
      }
      pending.clear();
      resolve({ code, signal });
    });
  });
  child.on('error', (e) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    pending.clear();
  });
  child.stdio[4].on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf(0);
      if (end === -1) break;
      const line = buffer.subarray(0, end).toString();
      buffer = buffer.subarray(end + 1);
      if (!line) continue;
      const m = JSON.parse(line),
        p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.reject(Error(JSON.stringify(m.error)));
        else p.resolve(m.result);
      }
    }
  });
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      if (ended) {
        reject(Error('Test browser closed'));
        return;
      }
      const requestId = ++id;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(Error(`CDP timeout: ${method}`));
      }, 30000);
      pending.set(requestId, { resolve, reject, timer });
      child.stdio[3].write(
        `${JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) })}\0`,
      );
    });
  }
  const instance = { send, child, exited };
  browser = instance;
  version = await send('Browser.getVersion');
  return instance;
}
async function stop(hard = false) {
  if (!browser) return;
  const old = browser;
  browser = null;
  if (hard) old.child.kill('SIGKILL');
  else await old.send('Browser.close').catch(() => {});
  await old.exited;
}
async function page() {
  const { targetId } = await browser.send('Target.createTarget', { url: origin });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Runtime.enable', {}, sessionId);
  async function evaluate(expression, awaitPromise = true) {
    const result = await browser.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true },
      sessionId,
    );
    if (result.exceptionDetails)
      throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }
  for (let i = 0; i < 100; i++) {
    if (await evaluate('Boolean(globalThis.bunkProbe)'))
      return {
        sessionId,
        evaluate,
        call: async (name, ...args) =>
          JSON.parse(
            await evaluate(
              `(async()=>JSON.stringify((await globalThis.bunkProbe[${JSON.stringify(name)}](...${JSON.stringify(args)})) ?? null,(_,v)=>typeof v==='bigint'?v.toString():v))()`,
            ),
          ),
      };
    await sleep(50);
  }
  throw Error('Browser fixture module failed to load');
}
const key = (n) => `bunk-v3-account:${n.toString(16).padStart(64, '0')}`;
async function rejects(p, pattern) {
  let message;
  try {
    await p;
  } catch (e) {
    message = e.message;
  }
  assert(message, 'Expected rejection');
  if (pattern) assert.match(message, pattern);
  return message;
}
async function crash(p, role) {
  await p.evaluate(`void globalThis.bunkProbe.signCrash(${JSON.stringify(role)})`, false);
  for (let i = 0; i < 200; i++) {
    if (await p.call('crashStatus')) {
      await stop(true);
      return;
    }
    await sleep(25);
  }
  throw Error('Missing signature-save crash boundary');
}
try {
  await launch();
  let a = await page(),
    b = await page();
  await a.call('open');
  await b.call('open');
  let race = await Promise.all([
    a.call('rawCas', 'main', key(1), null, 'a'),
    b.call('rawCas', 'main', key(1), null, 'b'),
  ]);
  assert.equal(race.filter(Boolean).length, 1);
  race = await Promise.all([
    a.call('rawCas', 'main', key(1), 0, 'a1'),
    b.call('rawCas', 'main', key(1), 0, 'b1'),
  ]);
  assert.equal(race.filter(Boolean).length, 1);
  await Promise.all([
    a.call('increment', 'main', key(1), 20),
    b.call('increment', 'main', key(1), 20),
  ]);
  assert.equal((await a.call('rawRead', 'main', key(1))).revision, 41);
  cases.push('two tabs serialize insert/update CAS and forty concurrent increments');
  await a.call('rawCas', 'main', key(2), null, 'original');
  const aborted = await a.call('abortAfterRequestSuccess', 'main', key(2));
  assert.deepEqual(aborted.row, { revision: 0, value: 'original' });
  cases.push('request success followed by transaction abort never returns committed success');
  const strict = await a.call('strictRequired', 'main', key(3));
  assert.equal(strict.row, null);
  cases.push('strict durability is requested; a simulated downgrade aborts without writing');
  const secret = 'public-test-approval-marker';
  await a.call('sealedCas', 'main', key(4), null, secret);
  assert.equal((await b.call('sealedRead', 'main', key(4))).value, secret);
  assert(!(await a.call('rawRead', 'main', key(4))).value.includes(secret));
  cases.push('encrypted records reopen across tabs without plaintext in stored value');
  const raw = await a.call('rawRead', 'main', key(4));
  await a.call('rawCas', 'main', key(5), null, raw.value);
  await rejects(a.call('sealedRead', 'main', key(5)));
  cases.push('ciphertext substitution across account keys is rejected');
  await a.call('closeDuringWrite', 'main', key(6));
  await rejects(a.call('rawRead', 'main', key(1)), /closed/);
  await a.call('close');
  await a.call('open');
  cases.push('connection close aborts or rejects in-flight writes');
  for (const bad of ['', `bunk-v3-account:${'0'.repeat(64)}`, 'bunk-v3-account:ABC'])
    await rejects(a.call('rawCas', 'main', bad, null, 'x'));
  for (const revision of [-1, 0.1, 2147483647])
    await rejects(a.call('rawCas', 'main', key(7), revision, 'x'));
  await a.call('corrupt', key(8), { revision: -1, value: 'x' });
  await rejects(a.call('rawRead', 'main', key(8)));
  await rejects(a.call('rawCas', 'main', key(8), null, 'overwrite'));
  cases.push('invalid keys/revisions and corrupt rows fail closed');
  await b.call('closeAll');
  await a.call('erased');
  for (const kind of ['store', 'key', 'auto']) await a.call('badSchema', kind);
  cases.push('incompatible database schemas are not repaired or deleted automatically');
  await a.call('erased');
  await a.call('open');
  await b.call('open');
  await a.call('upgrade');
  await rejects(b.call('rawRead', 'main', key(1)), /closed/);
  await rejects(a.call('open'), /version|Version/i);
  cases.push('schema upgrade closes old handles; unsupported new version is refused');
  await b.call('closeAll');
  await a.call('closeAll');
  await a.call('blockedTimeout');
  cases.push('blocked open times out and its late request cannot leak a connection');
  await a.call('erased');
  await a.call('missingHistory');
  cases.push('empty browser history remains fenced by the v3 account coordinator');
  await a.call('erased');
  await a.call('open');
  await b.call('open');
  const reservations = await Promise.allSettled([a.call('reserveOwner'), b.call('reserveOwner')]);
  assert.equal(reservations.filter((r) => r.status === 'fulfilled').length, 1);
  cases.push('actual encrypted v3 owner journal admits only one approval across tabs');
  await crash(a, 'owner');
  await launch();
  a = await page();
  await a.call('open');
  let journal = await a.call('journal');
  assert.equal(journal.owner, 'signing');
  assert.equal(journal.ownerSignature, null);
  await rejects(a.call('signOwner'), /claimed/);
  await a.call('reconstructOwner');
  cases.push(
    'hard browser termination before owner-signature persistence retains uncertainty; fresh process reconstructs golden bytes',
  );
  await a.call('reserveLeaf');
  await crash(a, 'leaf');
  await launch();
  a = await page();
  await a.call('open');
  journal = await a.call('journal');
  assert.equal(journal.envelopes[0].phase, 'signing');
  assert.equal(journal.envelopes[0].signature, null);
  await rejects(a.call('signLeaf'), /claimed/);
  const recovered = await a.call('reconstructLeaf');
  assert.equal(recovered.authorizationBytes, 1120);
  cases.push(
    'hard browser termination before leaf-signature persistence retains uncertainty; fresh process reconstructs exact 1120-byte authorization',
  );
  await stop();
  await launch();
  a = await page();
  await a.call('open');
  assert.deepEqual(await a.call('savedLeaf'), recovered);
  cases.push('graceful full browser restart reopens identical saved authorization');
  journal = await a.call('journal');
  assert.equal(journal.owner, 'signed');
  assert.equal(journal.envelopes[0].phase, 'signed');
  await a.call('closeAll');
  await stop();
  assert.deepEqual(hashes(), before, 'Source files changed during browser acceptance');
  fs.writeFileSync(
    output,
    `${JSON.stringify(
      {
        scope:
          'Real isolated Chrome pages/profile and encrypted v3 per-owner journal; coordinator missing-history gate included; not packaged MV3 worker, power-loss or production certification',
        browser: version,
        browserProcessStarts: sequence,
        hardTerminations: 2,
        origin,
        strictDurabilityRequired: true,
        cases,
        finalJournal: journal,
        sourcesSha256: before,
        bundleSha256: sha(bundle),
        sourceHashesRechecked: true,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Browser journal acceptance passed: ${cases.length} cases; evidence ${output}`);
} finally {
  await stop().catch(() => {});
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(`Browser test logs/bundle retained in ${work}`);
}
