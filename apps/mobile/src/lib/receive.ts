import type { ChainFamily } from '@honey-wallet/keyring';
import type { AddedWallet } from '@/lib/wallets';

/** One address to receive on, and what can be sent to it. */
export type ReceiveAddress = {
  family: ChainFamily;
  /** Where it works, e.g. "Bitcoin" or "Ethereum, Base and other EVM networks". */
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
  bitcoin: { title: 'Bitcoin', name: 'Bitcoin', symbol: 'BTC' },
  solana: { title: 'Solana', name: 'Solana', symbol: 'SOL' },
  tron: { title: 'Tron', name: 'Tron', symbol: 'TRX' },
  xrp: { title: 'XRP Ledger', name: 'XRP Ledger', symbol: 'XRP' },
};

const ORDER: ChainFamily[] = ['evm', 'bitcoin', 'solana', 'tron', 'xrp'];

// BIP-21, EIP-681 and Solana Pay prefixes; Tron and XRP wallets scan the bare address.
const uriFor = (family: ChainFamily, address: string) =>
  family === 'evm'
    ? `ethereum:${address}`
    : family === 'bitcoin'
      ? `bitcoin:${address}`
      : family === 'solana'
        ? `solana:${address}`
        : address;

/**
 * Every address a wallet can receive on. Each chain has its own address, so sending
 * Bitcoin to the EVM address would lose it: wallets with keys on this device list one
 * per chain, and the rest (watched, demo) only their EVM address.
 */
export function receiveAddresses(wallet: AddedWallet): ReceiveAddress[] {
  const addresses = wallet.addresses ?? { evm: wallet.address };
  return ORDER.flatMap((family) => {
    const address = addresses[family];
    return address ? [{ family, ...FAMILIES[family], address, uri: uriFor(family, address) }] : [];
  });
}
