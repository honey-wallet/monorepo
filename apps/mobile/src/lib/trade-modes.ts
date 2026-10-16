import { useActiveMultisig } from '@/lib/multisig';
import { type TradeMode, useSettings } from '@/lib/settings';

/**
 * What a shared wallet can trade: just Swap. Perps, Predict, Futures and Options
 * need one person's quick calls (opening and closing positions as prices move), which
 * a round of approvals can't keep up with.
 */
export const SHARED_WALLET_MODES: readonly TradeMode[] = ['Swap'];

/** The Trade tabs for the wallet in use: your chosen tabs, or Swap alone on a shared wallet. */
export function useTradeModes(): TradeMode[] {
  const multisig = useActiveMultisig();
  const { tradeTabs } = useSettings();
  return multisig ? [...SHARED_WALLET_MODES] : tradeTabs;
}

/** Whether the wallet in use can open a product (shared wallets can only swap). */
export function useTradeModeAllowed(mode: TradeMode) {
  const multisig = useActiveMultisig();
  return !multisig || SHARED_WALLET_MODES.includes(mode);
}
