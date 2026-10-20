import { expect, it } from 'vitest';
import type { Multisig } from '@/lib/multisig';
import { multisigDeployments } from '@/lib/multisig-deployments';

const ms = (walletId: string, chainId: number | null, addresses: string[]) =>
  ({
    walletId,
    network: { name: String(chainId), chainId, native: 'ETH' },
    members: addresses.map((address, i) => ({ id: `m${i}`, name: '', kind: 'person', address })),
  }) as unknown as Multisig;

it('groups shared wallets with the same members on other chains, in any order', () => {
  const a = ms('a', 1, ['0xAA', '0xbb']);
  const b = ms('b', 8453, ['0xBB', '0xaa']);
  const c = ms('c', 8453, ['0xaa', '0xcc']);
  const all = { a, b, c };
  expect(multisigDeployments(a, all).map((m) => m.walletId)).toEqual(['a', 'b']);
  expect(multisigDeployments(b, all).map((m) => m.walletId)).toEqual(['b', 'a']);
  expect(multisigDeployments(c, all).map((m) => m.walletId)).toEqual(['c']);
});
