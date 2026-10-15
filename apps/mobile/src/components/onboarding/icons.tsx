import Svg, { Circle, Path } from 'react-native-svg';

type IconProps = { size?: number; color: string };
type ChevronProps = IconProps & { weight?: number };

export function CloseIcon({ size = 22, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M5.5 5.5l13 13M18.5 5.5l-13 13"
        stroke={color}
        strokeWidth={2.6}
        strokeLinecap="round"
      />
    </Svg>
  );
}

export function BackIcon({ size = 22, color, weight = 2.6 }: ChevronProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M15 4.5L7.5 12l7.5 7.5"
        stroke={color}
        strokeWidth={weight}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

export function ForwardIcon({ size = 22, color, weight = 2.6 }: ChevronProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M9 4.5l7.5 7.5L9 19.5"
        stroke={color}
        strokeWidth={weight}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

export function HelpIcon({ size = 26, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Circle cx={12} cy={12} r={10} stroke={color} strokeWidth={2} fill="none" />
      <Path
        d="M9.2 9.3a2.9 2.9 0 0 1 5.6 0.9c0 1.9-2.8 2.4-2.8 4.3"
        stroke={color}
        strokeWidth={2.1}
        strokeLinecap="round"
        fill="none"
      />
      <Circle cx={12} cy={17.6} r={1.25} fill={color} />
    </Svg>
  );
}

export function EyeIcon({ size = 22, color, off = false }: IconProps & { off?: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M12 5.5C7 5.5 3.4 9.4 2.2 12c1.2 2.6 4.8 6.5 9.8 6.5s8.6-3.9 9.8-6.5C20.6 9.4 17 5.5 12 5.5z"
        stroke={color}
        strokeWidth={2}
        fill="none"
      />
      <Circle cx={12} cy={12} r={3} fill={color} />
      {off && <Path d="M4 4l16 16" stroke={color} strokeWidth={2.2} strokeLinecap="round" />}
    </Svg>
  );
}

export function ShuffleIcon({ size = 20, color }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M3 7h3.5c2.2 0 3.6 1.1 4.8 3l1.4 2.2c1.2 1.9 2.6 3 4.8 3H21M3 17h3.5c1.6 0 2.8-.6 3.8-1.7M13.7 8.7c1-1.1 2.2-1.7 3.8-1.7H21M18 4l3 3-3 3M18 14l3 3-3 3"
        stroke={color}
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}
