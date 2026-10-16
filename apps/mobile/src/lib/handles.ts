import { useFirstLoad } from '@/components/motion/Skeleton';
import { LOADS } from '@/lib/loads';
import { isHoneyHandle } from '@/lib/wallets';

/**
 * True while a typed name.honey handle is still being looked up. Addresses and
 * half-typed text never wait.
 */
export function useHandleLookup(value: string): boolean {
  const handle = isHoneyHandle(value);
  const resolving = useFirstLoad(LOADS.handle(handle ? value.trim() : ''));
  return handle && resolving;
}
