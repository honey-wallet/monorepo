import { BALANCE, BALANCE_CHANGE, TOKENS, type Token, tokenName } from '@/lib/mock-wallet';
import { useMultisig } from '@/lib/multisig';
import { useActiveWallet } from '@/lib/wallets';

/**
 * What the wallet in use holds, for every screen that shows a balance: a shared
 * wallet shows its own balances; other wallets show the demo portfolio.
 */
export function useWalletView() {
  const wallet = useActiveWallet();
  const multisig = useMultisig(wallet.id);
  if (!multisig) {
    return { wallet, multisig, usd: BALANCE, change: BALANCE_CHANGE, tokens: TOKENS };
  }
  const tokens: Token[] = multisig.holdings.map((h) => ({
    symbol: h.symbol,
    name: tokenName(h.symbol),
    amount: h.amount,
    usd: h.usd,
    change: TOKENS.find((t) => t.symbol === h.symbol)?.change ?? 0,
  }));
  const usd = tokens.reduce((sum, t) => sum + t.usd, 0);
  const change = tokens.reduce((sum, t) => sum + (t.usd * t.change) / 100, 0);
  return { wallet, multisig, usd, change, tokens };
}
