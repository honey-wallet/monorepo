// Builds Honey for Chrome from the mobile app: the same screens and components, exported
// for the web by Expo, then made into an MV3 extension in dist/.
//
//   pnpm --filter @honey-wallet/extension build   →  load apps/extension/dist unpacked
//
// Three things make an Expo web export loadable as an extension:
// - Chrome refuses files and folders whose names start with "_" (`_expo`, `__node_modules`),
//   so those are renamed and every reference to them rewritten.
// - Extension pages can't run inline scripts, so the page gets only external ones.
// - The router reads the page's path, which is /index.html; public/boot.js resets it first.
// Then the scripts that connect websites (src/worker) are bundled beside it.
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mobile = join(root, '..', 'mobile');
// `--out=<dir>` builds somewhere else, so several screenshot runs can build at once.
const outArg = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
const out = outArg ?? join(root, process.argv.includes('--e2e') ? 'dist-e2e' : 'dist');

rmSync(out, { recursive: true, force: true });
const exported = spawnSync(
  'pnpm',
  // --clear: EXPO_PUBLIC_* values are inlined into Metro's cached modules, so without it
  // a --e2e build could ship in the next normal one (or lose its test hook).
  ['exec', 'expo', 'export', '--platform', 'web', '--output-dir', out, '--clear'],
  {
    cwd: mobile,
    stdio: 'inherit',
    env: {
      ...process.env,
      HONEY_TARGET: 'extension',
      EXPO_PUBLIC_TARGET: 'extension',
      // `pnpm build --e2e` adds the screenshot runs' test hook (see app/_layout.tsx).
      EXPO_PUBLIC_E2E: process.argv.includes('--e2e') ? '1' : '0',
      CI: '1',
    },
  },
);
if (exported.status !== 0) process.exit(exported.status ?? 1);

// Rename every path segment that starts with "_", deepest first, and remember the swaps.
const renames = new Map();
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    if (name.startsWith('_')) {
      const next = `x${name}`;
      renameSync(path, join(dir, next));
      renames.set(name, next);
    }
  }
}
walk(out);

const TEXT = /\.(html|js|css|json|map)$/;
function rewrite(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      rewrite(path);
      continue;
    }
    if (!TEXT.test(name)) continue;
    let text = readFileSync(path, 'utf8');
    const before = text;
    for (const [from, to] of renames) text = text.split(`/${from}/`).join(`/${to}/`);
    if (text !== before) writeFileSync(path, text);
  }
}
rewrite(out);

// The page: no inline scripts, boot.js before the app, and the popup's size.
const indexPath = join(out, 'index.html');
let html = readFileSync(indexPath, 'utf8');
html = html.replace(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g, '');
html = html.replace(
  '</head>',
  '<link rel="stylesheet" href="/popup.css" /><script src="/boot.js"></script></head>',
);
if (/<script(?![^>]*\bsrc=)/.test(html)) throw new Error('index.html still has an inline script');
writeFileSync(indexPath, html);

cpSync(join(root, 'public'), out, { recursive: true });
if (!existsSync(join(out, 'manifest.json'))) throw new Error('manifest.json missing');

// The scripts websites talk to (src/worker): the service worker, the content script and
// the provider pages see. Each is one self-contained file; content scripts can't import.
const icon = `data:image/png;base64,${readFileSync(join(root, 'public/icons/icon-48.png')).toString('base64')}`;
for (const name of ['background', 'content', 'inpage']) {
  await build({
    configFile: false,
    logLevel: 'warn',
    define: { __HONEY_ICON__: JSON.stringify(icon) },
    build: {
      outDir: out,
      emptyOutDir: false,
      minify: false,
      target: 'chrome116',
      lib: {
        entry: join(root, `src/worker/${name}.ts`),
        formats: ['iife'],
        name: `honey_${name}`,
        fileName: () => `${name}.js`,
      },
    },
  });
}
console.log(`\nHoney Wallet extension built in ${out}`);
