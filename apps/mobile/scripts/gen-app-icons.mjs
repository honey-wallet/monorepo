// Rasterize the existing Honey vector mark. Run with `pnpm icons` in apps/mobile.
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const source = await readFile(new URL('../src/components/logo/paths.ts', import.meta.url), 'utf8');
const path = (name) => {
  const value = source.match(new RegExp(`export const ${name} =\\s*'([^']+)'`))?.[1];
  if (!value) throw new Error(`Missing logo path: ${name}`);
  return value;
};
const ring = path('RING_PATH');
const eyes = path('EYES_PATH');
const assets = new URL('../assets/images/', import.meta.url);

async function render(file, { background, mark, eye = background, width = 680, size = 1024 }) {
  const height = width * (350 / 400);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
    ${background ? `<rect width="1024" height="1024" fill="${background}"/>` : ''}
    <svg x="${(1024 - width) / 2}" y="${(1024 - height) / 2}" width="${width}" height="${height}" viewBox="244 203 400 350">
      <defs><mask id="mark" maskUnits="userSpaceOnUse" x="244" y="203" width="400" height="350">
        <path fill="white" fill-rule="evenodd" d="${ring}"/>
        <path fill="black" d="${eyes}"/>
      </mask></defs>
      <path fill="${mark}" mask="url(#mark)" fill-rule="evenodd" d="${ring}"/>
      ${eye ? `<path fill="${eye}" d="${eyes}"/>` : ''}
    </svg>
  </svg>`;
  let image = sharp(Buffer.from(svg)).resize(size, size);
  if (background) image = image.removeAlpha();
  await writeFile(new URL(file, assets), await image.png().toBuffer());
}

// The launch animation's look: the yellow mark with full brown eyes, on white (or black).
// const honey = { background: '#FEBE2B', mark: '#4B2817' };
const honey = { background: '#FFFFFF', mark: '#FEBE2B', eye: '#4B2817' };
const honeyDark = { background: '#000000', mark: '#FEBE2B', eye: '#4B2817' };
const midnight = { background: '#17140F', mark: '#FEBE2B' };
const graphite = { background: '#292929', mark: '#FFFFFF' };
for (const [file, colors] of Object.entries({
  'icon.png': honey,
  'ios-light.png': honey,
  'ios-dark.png': honeyDark,
  'ios-tinted.png': { background: '#202020', mark: '#FFFFFF' },
  'icon-midnight.png': midnight,
  'icon-graphite.png': graphite,
}))
  await render(file, colors);

// Adaptive icons keep the entire mark inside Android's central safe area.
await render('android-icon-foreground.png', {
  mark: honey.mark,
  eye: honey.eye,
  width: 600,
});
await render('android-icon-midnight.png', {
  mark: midnight.mark,
  eye: midnight.background,
  width: 600,
});
await render('android-icon-graphite.png', {
  mark: graphite.mark,
  eye: graphite.background,
  width: 600,
});
await render('android-icon-monochrome.png', { mark: '#FFFFFF', width: 600 });
await render('favicon.png', { ...honey, size: 64 });
console.log('Generated Honey, Midnight and Graphite app icons.');
