import qrcode from 'qrcode-generator';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Rect } from 'react-native-svg';

type Props = {
  value: string;
  size: number;
  color: string;
  /** Drawn in a clear circle in the middle, e.g. the wallet's avatar. */
  center?: ReactNode;
};

/** A QR code drawn as dots with rounded finder squares, after Uniswap's receive code. */
export function QRCode({ value, size, color, center }: Props) {
  const { count, dots } = useMemo(() => {
    // High error correction so the centre artwork doesn't stop it scanning.
    const qr = qrcode(0, 'H');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    const isFinder = (r: number, col: number) =>
      (r < 7 && col < 7) || (r < 7 && col >= n - 7) || (r >= n - 7 && col < 7);
    const clear = n * 0.28;
    const mid = n / 2;
    const out: [number, number][] = [];
    for (let r = 0; r < n; r++) {
      for (let col = 0; col < n; col++) {
        if (!qr.isDark(r, col) || isFinder(r, col)) continue;
        if (Math.abs(r + 0.5 - mid) < clear / 2 && Math.abs(col + 0.5 - mid) < clear / 2) continue;
        out.push([r, col]);
      }
    }
    return { count: n, dots: out };
  }, [value]);

  const cell = size / count;
  const finder = (x: number, y: number) => (
    <>
      <Rect
        x={x + cell * 0.5}
        y={y + cell * 0.5}
        width={cell * 6}
        height={cell * 6}
        rx={cell * 1.8}
        fill="none"
        stroke={color}
        strokeWidth={cell}
      />
      <Rect
        x={x + cell * 2}
        y={y + cell * 2}
        width={cell * 3}
        height={cell * 3}
        rx={cell}
        fill={color}
      />
    </>
  );

  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size}>
        {dots.map(([r, col]) => (
          <Circle
            key={`${r}-${col}`}
            cx={(col + 0.5) * cell}
            cy={(r + 0.5) * cell}
            r={cell * 0.42}
            fill={color}
          />
        ))}
        {finder(0, 0)}
        {finder((count - 7) * cell, 0)}
        {finder(0, (count - 7) * cell)}
      </Svg>
      {center ? (
        <View
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {center}
        </View>
      ) : null}
    </View>
  );
}
