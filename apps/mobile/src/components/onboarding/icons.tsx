import Svg, { Circle, G, Path, Rect } from 'react-native-svg';

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

/** A recovery phrase: its words as a little grid of chips, two columns of three. */
export function PhraseGlyph({ color, size = 20 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      {[3, 8.5, 14].map((y) =>
        [2, 11].map((x) => (
          <Rect key={`${x}-${y}`} x={x} y={y} width={7} height={3.5} rx={1.75} fill={color} />
        )),
      )}
    </Svg>
  );
}

/**
 * A private key: a solid key tipped at 45°, round head (with its hole) up and to the
 * right, the blade running down-left with two notched teeth. Drawn level, then turned.
 */
export function KeyGlyph({ color, size = 20 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20">
      <G rotation={-45} origin="10, 10">
        {/* Head, with the hole cut out */}
        <Path
          fill={color}
          fillRule="evenodd"
          d="M9.2 10a5.3 5.3 0 1 0 10.6 0a5.3 5.3 0 1 0 -10.6 0ZM15.4 10a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0 -3.4 0Z"
        />
        {/* Blade and teeth */}
        <Path
          fill={color}
          d="M10.5 8.4H1.6a1.2 1.2 0 0 0 -1.2 1.2v3.6a1 1 0 0 0 1 1h1.6v-1.6h1.8v1.1h1.9v-2.1h3.8Z"
        />
      </G>
    </Svg>
  );
}
