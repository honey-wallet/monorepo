import type { Multisig } from '@/lib/multisig';

/** The parties behind a shared wallet, order-insensitive: its members' addresses. */
export const memberKey = (m: Pick<Multisig, 'members'>) =>
  m.members
    .map((x) => x.address.toLowerCase())
    .sort()
    .join(',');

/**
 * A Safe or Squads lives on one chain, with its own address there. Shared wallets with the
 * same parties on other chains are deployments of one wallet: this one first, then the
 * rest in the order they were added.
 */
export function multisigDeployments(wallet: Multisig, all: Record<string, Multisig>): Multisig[] {
  const key = memberKey(wallet);
  const others = Object.values(all).filter(
    (m) => m.walletId !== wallet.walletId && memberKey(m) === key,
  );
  return [wallet, ...others];
}
