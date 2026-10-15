import { useEffect, useState } from 'react';

/**
 * False during the first render, true afterwards. Swap components use it so content
 * that's there when a screen opens appears at once; only later changes animate.
 */
export function useHasMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
