import {
  createNearClient,
  type NearNetwork,
  NearRpcError,
  type NearTransfer,
  nearTransferOutcome,
  signNearTransfer,
} from '@honey-wallet/keyring';
import { confirmOwner } from '@/lib/auth';
import * as SecureStore from '@/lib/secure-store';
import { TEST_MODE } from '@/lib/test-mode';
import { privateKeyOf } from '@/lib/vault';
import { wallets } from '@/lib/wallets';

export type NearReceipt = {
  hash: string;
  signerId: string;
  receiverId: string;
  amount: string;
  network: NearNetwork;
  state: 'pending' | 'success' | 'failure';
  /** Encrypted with the vault; retry only these exact bytes after an interrupted broadcast. */
  signedTransaction?: string;
};
const receiptKey = (accountId: string, network: NearNetwork) =>
  `honey.near.${network}.${accountId}`;

export async function loadNearReceipt(
  accountId: string,
  network: NearNetwork,
): Promise<NearReceipt | null> {
  const json = await SecureStore.getItemAsync(receiptKey(accountId, network));
  return json ? (JSON.parse(json) as NearReceipt) : null;
}
async function saveReceipt(accountId: string, receipt: NearReceipt) {
  if (receipt.state !== 'pending') delete receipt.signedTransaction;
  await SecureStore.setItemAsync(receiptKey(accountId, receipt.network), JSON.stringify(receipt));
  return receipt;
}

const submitting = new Set<string>();
export async function sendNear(accountId: string, review: NearTransfer, isCurrent: () => boolean) {
  const scope = receiptKey(accountId, review.network);
  if (submitting.has(scope)) throw new Error('A NEAR transfer is already in progress');
  submitting.add(scope);
  const tx = Object.freeze({ ...review });
  let signed: ReturnType<typeof signNearTransfer> | undefined;
  const assertCurrent = () => {
    const state = wallets.get();
    const wallet = state.added.find((item) => item.id === accountId);
    if (
      TEST_MODE ||
      wallet?.demo ||
      wallet?.watchOnly ||
      state.activeId !== accountId ||
      wallet?.addresses?.near !== tx.signerId ||
      !isCurrent()
    )
      throw new Error('Wallet changed or unavailable. Review the transfer again.');
    const age = Date.now() - tx.preparedAt;
    if (age < 0 || age > 60_000) throw new Error('NEAR review expired. Review the transfer again.');
  };
  try {
    assertCurrent();
    if ((await loadNearReceipt(accountId, tx.network))?.state === 'pending')
      throw new Error('Check the pending NEAR transfer before sending again.');
    if (!(await confirmOwner('Confirm NEAR transfer', true))) throw new Error('Transfer cancelled');
    assertCurrent();
    const key = await privateKeyOf(accountId, 'near');
    try {
      assertCurrent();
      signed = signNearTransfer(key, tx);
    } finally {
      key.fill(0);
    }
    assertCurrent();
    // Persist before broadcast. A popup close or timeout must never invite a duplicate send.
    const receipt: NearReceipt = {
      hash: signed.hash,
      network: tx.network,
      signerId: tx.signerId,
      receiverId: tx.receiverId,
      amount: tx.amount.toString(),
      state: 'pending',
      signedTransaction: signed.signedTransaction,
    };
    await saveReceipt(accountId, receipt);
    // There are no asynchronous calls between this fence and initiating the broadcast.
    try {
      assertCurrent();
    } catch (error) {
      await saveReceipt(accountId, { ...receipt, state: 'failure' });
      throw error;
    }
    try {
      const result = await createNearClient(tx.network).submit(signed.signedTransaction);
      receipt.state = nearTransferOutcome(result, receipt.hash, receipt.signerId);
    } catch {
      // An RPC error cannot prove that the transaction was not accepted.
      return receipt;
    }
    return saveReceipt(accountId, receipt);
  } finally {
    if (signed) signed.signedTransaction = '';
    submitting.delete(scope);
  }
}

export async function refreshNearReceipt(
  accountId: string,
  network: NearNetwork,
  isCurrent: () => boolean = () => true,
) {
  const scope = receiptKey(accountId, network);
  if (submitting.has(scope)) throw new Error('A NEAR transfer is already in progress');
  submitting.add(scope);
  try {
    const receipt = await loadNearReceipt(accountId, network);
    if (receipt?.state !== 'pending') return receipt;
    const client = createNearClient(network);
    let result: unknown;
    try {
      result = await client.status(receipt.hash, receipt.signerId);
    } catch (error) {
      if (
        !(error instanceof NearRpcError) ||
        !error.hasCause('UNKNOWN_TRANSACTION') ||
        !receipt.signedTransaction
      )
        throw error;
      const state = wallets.get();
      const wallet = state.added.find((item) => item.id === accountId);
      if (
        TEST_MODE ||
        !isCurrent() ||
        state.activeId !== accountId ||
        wallet?.demo ||
        wallet?.watchOnly ||
        wallet?.addresses?.near !== receipt.signerId
      )
        throw new Error('Wallet changed or unavailable. Reopen NEAR to check this transfer.');
      // Replaying identical signed bytes is idempotent at the protocol layer.
      result = await client.submit(receipt.signedTransaction);
    }
    return saveReceipt(accountId, {
      ...receipt,
      state: nearTransferOutcome(result, receipt.hash, receipt.signerId),
    });
  } finally {
    submitting.delete(scope);
  }
}
