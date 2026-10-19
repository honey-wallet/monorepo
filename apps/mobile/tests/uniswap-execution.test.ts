import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  swapExecutionFixture,
  swapFixtureNow,
} from '../../../packages/api-client/src/fixtures/swap-execution';

const m = vi.hoisted(() => ({
  confirm: vi.fn(),
  key: vi.fn(),
  sign: vi.fn(),
  typed: vi.fn(),
  verify: vi.fn(),
  address: vi.fn(),
  submit: vi.fn(),
  permit: vi.fn(),
  token: 'token',
  active: 'wallet',
  profile: null as unknown,
}));
vi.mock('@/lib/api', () => ({ api: { submitSwap: m.submit, submitSwapPermit: m.permit } }));
vi.mock('@/lib/auth', () => ({ confirmOwner: m.confirm }));
vi.mock('@/lib/vault', () => ({ privateKeyOf: m.key }));
vi.mock('@/lib/backend-session', () => ({
  backendSessionToken: () => m.token,
  backendSession: { get: () => ({ profile: m.profile }) },
}));
vi.mock('@/lib/wallets', () => ({ wallets: { get: () => ({ activeId: m.active }) } }));
vi.mock('@honey-wallet/keyring', () => ({
  evmAddressOfKey: m.address,
  signEvmTransaction: m.sign,
  signEvmTypedData: m.typed,
  verifyEvmTypedDataSignature: m.verify,
}));

import { signReviewedSwap, signReviewedSwapPermit } from '@/lib/uniswap-execution';

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(swapFixtureNow);
  const { c } = swapExecutionFixture();
  m.token = 'token';
  m.active = 'wallet';
  m.profile = { wallet: { id: 'id', address: c.signer, chainId: 'eip155:31337' } };
  m.address.mockReturnValue(c.signer);
  m.confirm.mockResolvedValue(true);
  m.key.mockResolvedValue(new Uint8Array(32).fill(7));
  m.sign.mockResolvedValue('signed');
  m.typed.mockResolvedValue('permit');
  m.verify.mockResolvedValue(true);
  m.submit.mockResolvedValue({});
  m.permit.mockResolvedValue({});
});
afterEach(() => vi.restoreAllMocks());
it('confirms finite token permission, wipes the key and only then submits', async () => {
  const { r, c } = swapExecutionFixture();
  const key = new Uint8Array(32).fill(9);
  m.key.mockResolvedValue(key);
  m.permit.mockImplementation(async () => expect(key.every((v) => v === 0)).toBe(true));
  await signReviewedSwapPermit(r, c, 'wallet', () => true);
  expect(m.confirm).toHaveBeenCalledWith('Confirm Uniswap token permission', true);
  expect(JSON.parse(m.typed.mock.calls[0]?.[1]).message.details.amount).toBe('1000');
  expect(m.permit).toHaveBeenCalledOnce();
});
it('recovers the EOA permit before transaction signing and rejects invalid recovery', async () => {
  const { r, c } = swapExecutionFixture();
  m.verify.mockResolvedValue(false);
  await expect(signReviewedSwap(r, c, 'wallet', () => true)).rejects.toThrow('signature');
  expect(m.key).not.toHaveBeenCalled();
  expect(m.confirm).not.toHaveBeenCalled();
  m.verify.mockResolvedValue(true);
  await signReviewedSwap(r, c, 'wallet', () => true);
  expect(m.sign).toHaveBeenCalledOnce();
  expect(m.submit).toHaveBeenCalledOnce();
});
it('cancellation and session changes cannot reach key access or submission', async () => {
  const { r, c } = swapExecutionFixture();
  m.confirm.mockResolvedValue(false);
  await expect(signReviewedSwapPermit(r, c, 'wallet', () => true)).rejects.toThrow('cancelled');
  expect(m.key).not.toHaveBeenCalled();
  m.confirm.mockImplementation(async () => {
    m.token = 'changed';
    return true;
  });
  await expect(signReviewedSwapPermit(r, c, 'wallet', () => true)).rejects.toThrow('session');
  expect(m.key).not.toHaveBeenCalled();
  expect(m.permit).not.toHaveBeenCalled();
});
it('foreground cancellation after signing wipes the key and never sends authority', async () => {
  const { r, c } = swapExecutionFixture();
  let live = true;
  const key = new Uint8Array(32).fill(8);
  m.key.mockResolvedValue(key);
  m.typed.mockImplementation(async () => {
    live = false;
    return 'permit';
  });
  await expect(signReviewedSwapPermit(r, c, 'wallet', () => live)).rejects.toThrow('session');
  expect(key.every((v) => v === 0)).toBe(true);
  expect(m.permit).not.toHaveBeenCalled();
});
it('snapshots reviewed terms before async confirmation', async () => {
  const { r, c } = swapExecutionFixture();
  const original = r.prepared.plan.steps[0]?.data;
  m.confirm.mockImplementation(async () => {
    r.prepared.plan.steps = [];
    c.intent.amountRaw = '999';
    return true;
  });
  await signReviewedSwap(r, c, 'wallet', () => true);
  expect(m.sign.mock.calls[0]?.[1].data).toBe(original);
});
