import type { ChainFamily } from '@honey-wallet/keyring';
import { type AddedWallet, canReceive } from '@/lib/wallets';

/** One address to receive on, and what can be sent to it. */
export type ReceiveAddress = {
  family: ChainFamily;
  /** Where it works, e.g. "Solana" or "Ethereum, Base and other EVM networks". */
  name: string;
  /** Short form for list rows. */
  title: string;
  /** Token logo shown beside it. */
  symbol: string;
  address: string;
  /** What the QR code encodes: a payment URI where wallets agree on one. */
  uri: string;
};

const FAMILIES: Record<ChainFamily, Omit<ReceiveAddress, 'family' | 'address' | 'uri'>> = {
  evm: { title: 'Ethereum & Base', name: 'Ethereum, Base and other EVM networks', symbol: 'ETH' },
  solana: { title: 'Solana', name: 'Solana', symbol: 'SOL' },
  near: { title: 'NEAR', name: 'NEAR Mainnet', symbol: 'NEAR' },
  tron: { title: 'Tron', name: 'Tron', symbol: 'TRX' },
  xrp: { title: 'XRP Ledger', name: 'XRP Ledger', symbol: 'XRP' },
};

// XRP and Tron aren't offered for receiving (review); their addresses still derive.
// Bitcoin was removed (2026-10-22): Bunk needs addresses that survive key rotation.
// NEAR: phrase wallets derive an implicit account (docs/NEAR.md); watched/imported-key wallets don't.
const ORDER: ChainFamily[] = ['evm', 'solana', 'near'];

/** Networks the one EVM address works on, shown as logos. */
export const EVM_LOGOS = [
  'ETH',
  'BASE',
  'ARB',
  'OP',
  'POL',
  'BNB',
  'AVAX',
  'GNO',
  'LINEA',
  'SCROLL',
];

// EIP-681 and Solana Pay prefixes; NEAR, Tron and XRP wallets scan the bare address.
const uriFor = (family: ChainFamily, address: string) =>
  family === 'evm' ? `ethereum:${address}` : family === 'solana' ? `solana:${address}` : address;

/**
 * Every address a wallet can receive on. Each chain has its own address, so sending
 * SOL to the EVM address would lose it: wallets with keys on this device list one
 * per chain. Explicitly watched wallets list their EVM address; simulations list none.
 */
export function receiveAddresses(wallet: AddedWallet): ReceiveAddress[] {
  if (!canReceive(wallet)) return [];
  const addresses = wallet.addresses ?? { evm: wallet.address };
  return ORDER.flatMap((family) => {
    const address = addresses[family];
    return address ? [{ family, ...FAMILIES[family], address, uri: uriFor(family, address) }] : [];
  });
}
