import { useActiveMultisig } from '@/lib/multisig';
import { AVAILABLE_TRADE_MODES, type TradeMode, useSettings } from '@/lib/settings';

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
  if (multisig) return [...SHARED_WALLET_MODES];
  // Products switched off for now never show, even if chosen before.
  const shown = tradeTabs.filter((m) => AVAILABLE_TRADE_MODES.includes(m));
  return shown.length ? shown : ['Swap'];
}

/** Whether the wallet in use can open a product (shared wallets can only swap). */
export function useTradeModeAllowed(mode: TradeMode) {
  const multisig = useActiveMultisig();
  if (!AVAILABLE_TRADE_MODES.includes(mode)) return false;
  return !multisig || SHARED_WALLET_MODES.includes(mode);
}
