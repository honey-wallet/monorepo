import { memo } from 'react';
import Svg, { Circle, Defs, Ellipse, G, LinearGradient, Path, Rect, Stop } from 'react-native-svg';
import type { Nft } from '@/lib/collectibles';

/** Muted palettes per collection (background top, bottom, then two accents), so the
 * art sits quietly in the grid. */
const PALETTES: Record<string, string[][]> = {
  'Honey Bears': [
    ['#F4EAD5', '#E6D2A9', '#7A5634', '#FBF5E9'],
    ['#E4EAF1', '#CBD6E3', '#6B5643', '#F7F3EC'],
    ['#F1E6E3', '#E0CCC6', '#6E4F3F', '#FBF4F0'],
  ],
  'Hive Pass': [['#2A2720', '#1A1814', '#C9A85C', '#E8D9AE']],
  'Based Blobs': [
    ['#E1E7F2', '#C6D1E6', '#4A5F8C', '#F5F7FB'],
    ['#DDEBEC', '#BFD8DA', '#3E6A6F', '#F3F8F8'],
  ],
  'Mad Lads': [['#ECECEC', '#D9D9D9', '#2B2B2B', '#B9625A']],
};

/** Generated art for a demo NFT, drawn from its seed so it's the same everywhere. */
export const NftArt = memo(function NftArt({ nft, size }: { nft: Nft; size: number }) {
  const set = PALETTES[nft.collection] ?? PALETTES['Based Blobs'];
  const [top, bottom, ink, light] = set[nft.seed % set.length];
  const id = `g-${nft.id}`;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={top} />
          <Stop offset="1" stopColor={bottom} />
        </LinearGradient>
      </Defs>
      <Rect width="100" height="100" fill={`url(#${id})`} />
      {nft.collection === 'Honey Bears' ? (
        <Bear ink={ink} light={light} seed={nft.seed} />
      ) : nft.collection === 'Hive Pass' ? (
        <Hive ink={ink} light={light} seed={nft.seed} />
      ) : nft.collection === 'Mad Lads' ? (
        <Lad ink={ink} accent={light} />
      ) : (
        <Blob ink={ink} light={light} seed={nft.seed} />
      )}
    </Svg>
  );
});

function Bear({ ink, light, seed }: { ink: string; light: string; seed: number }) {
  const wink = seed % 2 === 1;
  return (
    <G>
      <Circle cx="30" cy="34" r="11" fill={ink} />
      <Circle cx="70" cy="34" r="11" fill={ink} />
      <Circle cx="30" cy="34" r="5" fill={light} />
      <Circle cx="70" cy="34" r="5" fill={light} />
      <Circle cx="50" cy="56" r="28" fill={ink} />
      <Ellipse cx="50" cy="66" rx="13" ry="10" fill={light} />
      <Ellipse cx="50" cy="61" rx="4.5" ry="3.2" fill={ink} />
      <Circle cx="39" cy="50" r="3.2" fill={light} />
      {wink ? (
        <Path d="M57 50 h7" stroke={light} strokeWidth="2.6" strokeLinecap="round" />
      ) : (
        <Circle cx="61" cy="50" r="3.2" fill={light} />
      )}
      <Path d="M45 70 q5 4 10 0" stroke={ink} strokeWidth="2" fill="none" strokeLinecap="round" />
    </G>
  );
}

function hex(cx: number, cy: number, r: number) {
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
  });
  return `M${pts.join(' L')} Z`;
}

function Hive({ ink, light, seed }: { ink: string; light: string; seed: number }) {
  const cells: { x: number; y: number; on: boolean }[] = [];
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 6; col++) {
      const x = 8 + col * 17 + (row % 2 ? 8.5 : 0);
      const y = 10 + row * 15;
      cells.push({ x, y, on: (row * 7 + col * 3 + seed) % 5 === 0 });
    }
  }
  return (
    <G>
      {cells.map((c) => (
        <Path
          key={`${c.x}-${c.y}`}
          d={hex(c.x, c.y, 8.6)}
          fill={c.on ? ink : 'none'}
          stroke={ink}
          strokeOpacity={c.on ? 1 : 0.35}
          strokeWidth="1.2"
        />
      ))}
      <Path d={hex(50, 52, 17)} fill={light} />
      <Path d={hex(50, 52, 11)} fill={ink} />
    </G>
  );
}

function Blob({ ink, light, seed }: { ink: string; light: string; seed: number }) {
  const w = 4 + (seed % 5);
  return (
    <G>
      <Path
        d={`M50 ${18 + w} C ${74 + w} ${18} ${86} ${44 + w} ${78} ${64} C ${70} ${86} ${30} ${88 - w} ${22} ${66} C ${14} ${44} ${28 - w} ${20} 50 ${18 + w} Z`}
        fill={ink}
      />
      <Ellipse cx="40" cy="50" rx="4" ry="6" fill={light} />
      <Ellipse cx="60" cy="50" rx="4" ry="6" fill={light} />
      <Path
        d="M42 64 q8 6 16 0"
        stroke={light}
        strokeWidth="2.6"
        fill="none"
        strokeLinecap="round"
      />
    </G>
  );
}

function Lad({ ink, accent }: { ink: string; accent: string }) {
  return (
    <G>
      <Path d="M18 100 C 22 74 38 68 50 68 C 62 68 78 74 82 100 Z" fill={accent} />
      <Circle cx="50" cy="44" r="20" fill={ink} />
      <Rect x="36" y="38" width="28" height="7" rx="3.5" fill={accent} />
      <Path
        d="M42 54 q8 5 16 0"
        stroke={accent}
        strokeWidth="2.6"
        fill="none"
        strokeLinecap="round"
      />
    </G>
  );
}
