import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '@/theme';
import { EYES_PATH, MARK_VIEWBOX, RING_PATH, WORDMARK_PATH, WORDMARK_VIEWBOX } from './paths';

const MARK_ASPECT = 400 / 350;
const WORDMARK_ASPECT = 459 / 160;

type Props = {
  /** `lockup` = mark beside the wordmark; `stacked` = mark above it. */
  variant?: 'mark' | 'wordmark' | 'lockup' | 'stacked';
  /** Height of the mark in points; the wordmark is sized to sit beside it. */
  height?: number;
};

/** The Honey logo, coloured for the current light/dark theme. */
export function HoneyLogo({ variant = 'lockup', height = 28 }: Props) {
  const c = useTheme();

  const mark = (
    <Svg width={height * MARK_ASPECT} height={height} viewBox={MARK_VIEWBOX}>
      <Path fill={c.brandYellow} fillRule="evenodd" d={RING_PATH} />
      <Path fill={c.brandEyes} d={EYES_PATH} />
    </Svg>
  );
  const wordHeight = height * (variant === 'stacked' ? 0.5 : 0.82);
  const wordmark = (
    <Svg width={wordHeight * WORDMARK_ASPECT} height={wordHeight} viewBox={WORDMARK_VIEWBOX}>
      <Path fill={c.brandWordmark} fillRule="evenodd" d={WORDMARK_PATH} />
    </Svg>
  );

  if (variant === 'mark') return mark;
  if (variant === 'wordmark') return wordmark;
  const stacked = variant === 'stacked';
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="Honey"
      style={{
        flexDirection: stacked ? 'column' : 'row',
        alignItems: 'center',
        gap: height * (stacked ? 0.12 : 0.3),
      }}
    >
      {mark}
      {wordmark}
    </View>
  );
}
