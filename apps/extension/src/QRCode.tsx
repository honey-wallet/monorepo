import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/** A plain QR code drawn as SVG squares, sized to fit `size` pixels. */
export function QRCode({ value, size }: { value: string; size: number }) {
  const { count, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    }
    return { count: n, path: d };
  }, [value]);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`-2 -2 ${count + 4} ${count + 4}`}
      role="img"
      aria-label="Pairing QR code"
      shapeRendering="crispEdges"
    >
      <rect x={-2} y={-2} width={count + 4} height={count + 4} fill="#fff" />
      <path d={path} fill="#242329" />
    </svg>
  );
}
