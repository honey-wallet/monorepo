import Svg, { Defs, Ellipse, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

/**
 * A Honey Jar, drawn in the logo's language: a jar of deep amber honey (lighter at the
 * top, as light through glass), the mark's two eyes, a dark lid and a drip over the
 * rim. The same colours read on light and dark, so it needs no theme of its own.
 */
export function HoneyJar({ size = 28 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Defs>
        <LinearGradient id="honey-jar" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#FFC93C" />
          <Stop offset="1" stopColor="#DE8F0C" />
        </LinearGradient>
      </Defs>
      {/* Lid and rim */}
      <Rect x={12} y={5} width={24} height={8} rx={3.5} fill="#5B3A1E" />
      <Rect x={15} y={12} width={18} height={4} rx={1.5} fill="#7A5230" />
      {/* Body */}
      <Path
        d="M15 16h18a7 7 0 0 1 7 7v12a9 9 0 0 1-9 9H17a9 9 0 0 1-9-9V23a7 7 0 0 1 7-7z"
        fill="url(#honey-jar)"
      />
      {/* Honey dripping over the rim */}
      <Path d="M27 16h7v5.5a3.5 3.5 0 0 1-7 0z" fill="#E8A010" />
      {/* Glass highlight */}
      <Rect x={11.5} y={22} width={3} height={11} rx={1.5} fill="#FFFFFF" opacity={0.5} />
      {/* The mark's eyes */}
      <Ellipse cx={20.5} cy={31} rx={2.2} ry={3.2} fill="#4B2817" />
      <Ellipse cx={28.5} cy={31} rx={2.2} ry={3.2} fill="#4B2817" />
    </Svg>
  );
}
