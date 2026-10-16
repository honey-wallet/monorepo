import { EYES_PATH, MARK_VIEWBOX, RING_PATH } from './logo-paths';

/** The Honey mark: the hexagon ring and its two eyes. */
export function Logo({ height = 40 }: { height?: number }) {
  return (
    <svg width={(height * 400) / 350} height={height} viewBox={MARK_VIEWBOX} aria-label="Honey">
      <path fill="#FEBE2B" fillRule="evenodd" d={RING_PATH} />
      <path fill="var(--eyes)" d={EYES_PATH} />
    </svg>
  );
}
