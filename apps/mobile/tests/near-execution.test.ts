import {
  mnemonicToSeed,
  NearRpcError,
  type NearTransfer,
  nearAddressOfKey,
  privateKeyFor,
  signNearTransfer,
} from '@honey-wallet/keyring';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  confirm: vi.fn(),
  key: vi.fn(),
  submit: vi.fn(),
  status: vi.fn(),
  save: vi.fn(),
  state: {
    activeId: 'wallet',
    added: [] as { id: string; addresses: { near: string }; demo?: boolean; watchOnly?: boolean }[],
  },
}));
vi.mock('@/lib/auth', () => ({ confirmOwner: mocks.confirm }));
vi.mock('@/lib/test-mode', () => ({ TEST_MODE: false }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: mocks.key }));
vi.mock('@/lib/wallets', () => ({ wallets: { get: () => mocks.state } }));
vi.mock('@/lib/secure-store', () => ({
  getItemAsync: async (key: string) => mocks.storage.get(key) ?? null,
  setItemAsync: mocks.save,
}));
vi.mock('@honey-wallet/keyring', async (original) => ({
  ...(await original<typeof import('@honey-wallet/keyring')>()),
  createNearClient: () => ({ submit: mocks.submit, status: mocks.status }),
}));

import { loadNearReceipt, refreshNearReceipt, sendNear } from '@/lib/near-execution';

let key: Uint8Array;
let review: NearTransfer;
let hash: string;
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.storage.clear();
  const seed = await mnemonicToSeed(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  );
  key = privateKeyFor(seed, 'near');
  seed.fill(0);
  review = Object.freeze({
    network: 'mainnet',
    signerId: nearAddressOfKey(key),
    receiverId: 'alice.near',
    amount: 10n ** 24n,
    nonce: 123n,
    blockHash: '11111111111111111111111111111111',
    preparedAt: Date.now(),
  });
  hash = signNearTransfer(key, review).hash;
  mocks.state = {
    activeId: 'wallet',
    added: [{ id: 'wallet', addresses: { near: review.signerId } }],
  };
  mocks.confirm.mockResolvedValue(true);
  mocks.key.mockResolvedValue(key);
  mocks.save.mockImplementation(async (name, value) => {
    mocks.storage.set(name, value);
  });
  mocks.submit.mockResolvedValue({
    final_execution_status: 'FINAL',
    transaction: { hash, signer_id: review.signerId },
    status: { SuccessValue: '' },
  });
});

it('persists the transaction reference before broadcast and wipes the private key', async () => {
  mocks.submit.mockImplementation(async () => {
    expect(await loadNearReceipt('wallet', 'mainnet')).toMatchObject({ hash, state: 'pending' });
    expect(key.every((byte) => byte === 0)).toBe(true);
    return {
      final_execution_status: 'FINAL',
      transaction: { hash, signer_id: review.signerId },
      status: { SuccessValue: '' },
    };
  });
  expect(await sendNear('wallet', review, () => true)).toMatchObject({ hash, state: 'success' });
  expect(mocks.key).toHaveBeenCalledWith('wallet', 'near');
});

it('keeps a timeout pending across reopen and checks the same hash without re-signing', async () => {
  mocks.submit.mockRejectedValue(new Error('timeout'));
  expect(await sendNear('wallet', review, () => true)).toMatchObject({ state: 'pending' });
  await expect(sendNear('wallet', review, () => true)).rejects.toThrow('pending');
  expect(mocks.submit).toHaveBeenCalledTimes(1);
  mocks.status.mockResolvedValue({
    final_execution_status: 'FINAL',
    transaction: { hash, signer_id: review.signerId },
    status: { SuccessValue: '' },
  });
  expect(await refreshNearReceipt('wallet', 'mainnet')).toMatchObject({ state: 'success' });
  expect(mocks.status).toHaveBeenCalledWith(hash, review.signerId);
  expect(mocks.key).toHaveBeenCalledTimes(1);
});

it('does not sign after cancellation, wallet changes, or expired review', async () => {
  mocks.confirm.mockResolvedValueOnce(false);
  await expect(sendNear('wallet', review, () => true)).rejects.toThrow('cancelled');
  mocks.confirm.mockImplementationOnce(async () => {
    mocks.state.activeId = 'other';
    return true;
  });
  await expect(sendNear('wallet', review, () => true)).rejects.toThrow('Wallet changed');
  mocks.state.activeId = 'wallet';
  await expect(
    sendNear('wallet', { ...review, preparedAt: Date.now() - 61_000 }, () => true),
  ).rejects.toThrow('expired');
  expect(mocks.key).not.toHaveBeenCalled();
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('fences stale screens after key access and still clears the key', async () => {
  let current = true;
  mocks.key.mockImplementation(async () => {
    current = false;
    return key;
  });
  await expect(sendNear('wallet', review, () => current)).rejects.toThrow('Wallet changed');
  expect(key.every((byte) => byte === 0)).toBe(true);
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('does not broadcast when durable storage fails', async () => {
  mocks.save.mockRejectedValue(new Error('disk full'));
  await expect(sendNear('wallet', review, () => true)).rejects.toThrow('disk full');
  expect(key.every((byte) => byte === 0)).toBe(true);
  expect(mocks.submit).not.toHaveBeenCalled();
});

it('prevents concurrent sends and rejects watched or demo wallets', async () => {
  let resolve!: (accepted: boolean) => void;
  mocks.confirm.mockReturnValue(
    new Promise<boolean>((done) => {
      resolve = done;
    }),
  );
  const first = sendNear('wallet', review, () => true);
  await expect(sendNear('wallet', review, () => true)).rejects.toThrow('already in progress');
  resolve(false);
  await expect(first).rejects.toThrow('cancelled');
  const wallet = mocks.state.added[0];
  if (!wallet) throw new Error('Missing test wallet');
  wallet.watchOnly = true;
  await expect(sendNear('wallet', review, () => true)).rejects.toThrow('unavailable');
  wallet.watchOnly = false;
  wallet.demo = true;
  await expect(sendNear('wallet', review, () => true)).rejects.toThrow('unavailable');
});

it('can recover a crash before broadcast by resending only the stored signed bytes', async () => {
  mocks.submit.mockRejectedValueOnce(new Error('connection lost'));
  await sendNear('wallet', review, () => true);
  const firstBytes = mocks.submit.mock.calls[0]?.[0];
  mocks.status.mockRejectedValue(new NearRpcError({ cause: { name: 'UNKNOWN_TRANSACTION' } }));
  expect(await refreshNearReceipt('wallet', 'mainnet')).toMatchObject({ state: 'success' });
  expect(mocks.submit.mock.calls[1]?.[0]).toBe(firstBytes);
  expect(mocks.key).toHaveBeenCalledTimes(1);
  expect((await loadNearReceipt('wallet', 'mainnet'))?.signedTransaction).toBeUndefined();
});

it('reports finalized failure and refuses a mismatched success response', async () => {
  mocks.submit.mockResolvedValueOnce({
    final_execution_status: 'FINAL',
    transaction: { hash, signer_id: review.signerId },
    status: { Failure: {} },
  });
  expect(await sendNear('wallet', review, () => true)).toMatchObject({ state: 'failure' });
  mocks.key.mockResolvedValue(
    privateKeyFor(
      await mnemonicToSeed(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      ),
      'near',
    ),
  );
  mocks.submit.mockResolvedValueOnce({
    final_execution_status: 'FINAL',
    transaction: { hash: 'another', signer_id: review.signerId },
    status: { SuccessValue: '' },
  });
  expect(await sendNear('wallet', review, () => true)).toMatchObject({ state: 'pending' });
});
