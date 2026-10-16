import Svg, { Ellipse, Path, Rect } from 'react-native-svg';
import { useTheme } from '@/theme';

/**
 * A Honey Jar, drawn in the logo's language: the brand yellow body with the mark's two
 * eyes, a lid in the wordmark colour (brown on light, cream on dark), a drip over the
 * rim and a glass highlight. For Honey Jar prompts and empty states.
 */
export function HoneyJar({ size = 28 }: { size?: number }) {
  const c = useTheme();
  const lid = c.brandWordmark;
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      {/* Lid and rim */}
      <Rect x={12} y={5} width={24} height={8} rx={3.5} fill={lid} />
      <Rect x={15} y={12} width={18} height={4} rx={1.5} fill={lid} opacity={0.7} />
      {/* Body */}
      <Path
        d="M15 16h18a7 7 0 0 1 7 7v12a9 9 0 0 1-9 9H17a9 9 0 0 1-9-9V23a7 7 0 0 1 7-7z"
        fill={c.brandYellow}
      />
      {/* Honey dripping over the rim */}
      <Path d="M27 16h7v5.5a3.5 3.5 0 0 1-7 0z" fill="#F2A900" />
      {/* Glass highlight */}
      <Rect x={11.5} y={22} width={3} height={11} rx={1.5} fill="#FFFFFF" opacity={0.45} />
      {/* The mark's eyes */}
      <Ellipse cx={20.5} cy={31} rx={2.2} ry={3.2} fill={c.brandEyes} />
      <Ellipse cx={28.5} cy={31} rx={2.2} ry={3.2} fill={c.brandEyes} />
    </Svg>
  );
}
