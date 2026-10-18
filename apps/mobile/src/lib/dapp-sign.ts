import type { Answer, Approval } from '@honey-wallet/extension/protocol';
import {
  evmNetwork,
  readSolanaTransaction,
  SOLANA_MAINNET,
  signEvmMessage,
  signEvmTransaction,
  signEvmTypedData,
  signSolanaMessage,
  signSolanaTransaction,
} from '@honey-wallet/keyring';
import { createPublicClient, type Hex, http, type TransactionSerializable } from 'viem';
import { privateKeyOf } from '@/lib/vault';

/**
 * What runs after you approve a website's request in Honey for Chrome: sign with the
 * wallet's key (read from the vault, used, then wiped), and for "send" fill in the nonce,
 * gas and fees and broadcast. Also reads what a request contains, to show it first.
 */

export type EvmTx = { from: string; to: string | null; value: Hex; data: Hex; gas?: Hex };

// Reading requests

/** A message as text when it is text, otherwise its hex. */
export function readableMessage(bytes: Uint8Array): { text: string; isText: boolean } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Control characters other than newlines and tabs mean it's data, not a message.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: that's the check
    if (!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) return { text, isText: true };
  } catch {
    // Not UTF-8.
  }
  return {
    text: `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`,
    isText: false,
  };
}

export function evmMessageBytes(message: string): Uint8Array {
  if (/^0x([0-9a-f]{2})*$/i.test(message)) {
    const hex = message.slice(2);
    return Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
      Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16),
    );
  }
  return new TextEncoder().encode(message);
}

/**
 * Sign-In with Ethereum (EIP-4361): the domain it's for, so a sign-in meant for another
 * site can be called out. Null when the message isn't a SIWE message.
 */
export function siweDomain(text: string): string | null {
  const match =
    /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^\s/]+) wants you to sign in with your Ethereum account:/i.exec(
      text,
    );
  return match?.[1] ?? null;
}

export const fromBase64 = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
export const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** The fee payer and size of a Solana transaction, or null if it can't be read. */
export function solanaSummary(base64: string) {
  try {
    const bytes = fromBase64(base64);
    const read = readSolanaTransaction(bytes);
    return {
      feePayer: read.feePayer,
      signers: read.signers,
      bytes: bytes.length,
      version: read.version,
    };
  } catch {
    return null;
  }
}

/** Well-known function selectors, to name the call. Approvals get a warning. */
const SELECTORS: Record<string, { name: string; risky?: boolean }> = {
  '0xa9059cbb': { name: 'Transfer tokens' },
  '0x23b872dd': { name: 'Transfer tokens from', risky: true },
  '0x095ea7b3': { name: 'Approve spending', risky: true },
  '0x39509351': { name: 'Increase allowance', risky: true },
  '0xa22cb465': { name: 'Approve all NFTs', risky: true },
  '0x42842e0e': { name: 'Transfer NFT' },
};

export function callName(data: Hex) {
  if (data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();
  return SELECTORS[selector] ?? { name: `Contract call · ${selector}` };
}

/** Typed-data messages that let someone else move your tokens. */
export const isPermit = (primaryType: string) =>
  /^Permit(Single|Batch|TransferFrom|BatchTransferFrom|WitnessTransferFrom)?$/.test(primaryType);

// EVM sending

const clientFor = (chainId: number) => {
  const network = evmNetwork(chainId);
  if (!network) throw new Error('Honey doesn’t support this network yet');
  return { network, client: createPublicClient({ transport: http(network.rpc) }) };
};

/**
 * Fills in what the site left out: nonce, gas (the node's estimate plus 20%) and fees
 * (EIP-1559 where the network has it). Throws the node's reason when it would fail.
 */
export async function prepareEvmSend(tx: EvmTx, chainId: number) {
  const { client } = clientFor(chainId);
  const call = {
    account: tx.from as Hex,
    to: (tx.to ?? undefined) as Hex | undefined,
    value: BigInt(tx.value),
    data: tx.data,
  };
  const [nonce, gas, fees] = await Promise.all([
    client.getTransactionCount({ address: tx.from as Hex, blockTag: 'pending' }),
    tx.gas
      ? Promise.resolve(BigInt(tx.gas))
      : client.estimateGas(call).then((g) => (g * 12n) / 10n),
    client
      .estimateFeesPerGas()
      .then((f) => ({ eip1559: true as const, ...f }))
      .catch(async () => ({ eip1559: false as const, gasPrice: await client.getGasPrice() })),
  ]);
  const base = { chainId, nonce, to: call.to ?? null, value: call.value, data: tx.data, gas };
  const unsigned: TransactionSerializable =
    fees.eip1559 && 'maxFeePerGas' in fees && fees.maxFeePerGas !== undefined
      ? {
          ...base,
          type: 'eip1559',
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        }
      : { ...base, type: 'legacy', gasPrice: 'gasPrice' in fees ? fees.gasPrice : undefined };
  const perGas =
    unsigned.type === 'eip1559' ? (unsigned.maxFeePerGas ?? 0n) : (unsigned.gasPrice ?? 0n);
  return { unsigned, maxFee: gas * perGas };
}

/** A node's error, short enough to show. */
export function reasonOf(error: unknown) {
  const text =
    (error as { shortMessage?: string })?.shortMessage ??
    (error instanceof Error ? error.message : String(error));
  return text.split('\n')[0]?.slice(0, 160) ?? 'Unknown error';
}

async function solanaRpc(method: string, params: unknown[]) {
  const res = await fetch(SOLANA_MAINNET.rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? 'Solana rejected the transaction');
  return body.result;
}

// Answering

/**
 * Signs (and for "send", broadcasts) what the site asked for with `walletId`'s key.
 * Returns the answer for the site; throws when signing or sending failed.
 */
export async function performApproval(approval: Approval, walletId: string): Promise<Answer> {
  const id = approval.id;
  const params = approval.params as Record<string, unknown>;
  const chain = approval.kind.startsWith('solana') ? 'solana' : 'evm';
  if (approval.kind === 'switchChain') return { id, result: null };
  const key = await privateKeyOf(walletId, chain);
  try {
    switch (approval.kind) {
      case 'evmSign':
        return { id, result: await signEvmMessage(key, params.message as string) };
      case 'evmTypedData':
        return { id, result: await signEvmTypedData(key, params.data as string) };
      case 'evmSend': {
        const chainId = params.chainId as number;
        const { client } = clientFor(chainId);
        const { unsigned } = await prepareEvmSend(params.tx as EvmTx, chainId);
        const signed = await signEvmTransaction(key, unsigned);
        return { id, result: await client.sendRawTransaction({ serializedTransaction: signed }) };
      }
      case 'solanaSignMessage': {
        const signature = signSolanaMessage(key, fromBase64(params.message as string));
        return { id, result: { signature: toBase64(signature) } };
      }
      case 'solanaSignTransaction': {
        const signed = signSolanaTransaction(key, fromBase64(params.transaction as string));
        return { id, result: { signedTransaction: toBase64(signed) } };
      }
      case 'solanaSend': {
        const signed = signSolanaTransaction(key, fromBase64(params.transaction as string));
        const signature = await solanaRpc('sendTransaction', [
          toBase64(signed),
          { encoding: 'base64', preflightCommitment: 'confirmed' },
        ]);
        return { id, result: { signature } };
      }
      default:
        throw new Error('Nothing to sign');
    }
  } finally {
    key.fill(0);
  }
}
