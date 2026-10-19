import { beforeEach, expect, it, vi } from 'vitest';
import { acrossExecutionFixture } from '../../../packages/api-client/src/fixtures/across-execution';

const m = vi.hoisted(() => ({
  confirm: vi.fn(),
  key: vi.fn(),
  sign: vi.fn(),
  address: vi.fn(),
  submit: vi.fn(),
  token: 'token',
  active: 'wallet',
  profile: null as unknown,
}));
vi.mock('@/lib/api', () => ({ api: { submitAcross: m.submit } }));
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
}));

import { signReviewedAcross } from '@/lib/across-execution';

beforeEach(() => {
  vi.resetAllMocks();
  const { context } = acrossExecutionFixture();
  m.token = 'token';
  m.active = 'wallet';
  m.profile = { wallet: { id: 'id', address: context.signer, chainId: 'eip155:31337' } };
  m.address.mockReturnValue(context.signer);
  m.confirm.mockResolvedValue(true);
  m.sign.mockResolvedValue('signed');
  m.submit.mockResolvedValue({});
});
it('confirms before key access, signs exact local source bundle and wipes before submitting once', async () => {
  const { signing, context } = acrossExecutionFixture();
  const key = new Uint8Array(32).fill(7);
  m.key.mockResolvedValue(key);
  m.submit.mockImplementation(async () => {
    expect(key.every((v) => v === 0)).toBe(true);
  });
  await signReviewedAcross(signing, context, 'wallet', () => true);
  expect(m.confirm).toHaveBeenCalledWith('Confirm Across transaction', true);
  expect(m.sign).toHaveBeenCalledTimes(2);
  expect(m.sign.mock.calls[1]?.[1]).toMatchObject({
    chainId: 31337,
    to: signing.review.sourceSpoke,
    data: signing.review.calldata,
    value: 0n,
  });
  expect(m.submit).toHaveBeenCalledOnce();
});
it('rejects changed destination calldata before confirmation or key access', async () => {
  const { signing, context } = acrossExecutionFixture();
  signing.review.terms.recipient = context.signer;
  await expect(signReviewedAcross(signing, context, 'wallet', () => true)).rejects.toThrow(
    'review',
  );
  expect(m.confirm).not.toHaveBeenCalled();
  expect(m.key).not.toHaveBeenCalled();
});
it('fences cancellation, renewed sessions and focus loss before exposing keys', async () => {
  const { signing, context } = acrossExecutionFixture();
  m.confirm.mockResolvedValue(false);
  await expect(signReviewedAcross(signing, context, 'wallet', () => true)).rejects.toThrow(
    'cancelled',
  );
  expect(m.key).not.toHaveBeenCalled();
  m.confirm.mockImplementation(async () => {
    m.token = 'new-session';
    return true;
  });
  await expect(signReviewedAcross(signing, context, 'wallet', () => true)).rejects.toThrow(
    'session changed',
  );
  expect(m.key).not.toHaveBeenCalled();
  await expect(signReviewedAcross(signing, context, 'wallet', () => false)).rejects.toThrow(
    'session changed',
  );
  expect(m.submit).not.toHaveBeenCalled();
});
it('discards partial signatures on wallet change and never retries an ambiguous submit', async () => {
  const { signing, context } = acrossExecutionFixture();
  const key = new Uint8Array(32).fill(7);
  m.key.mockResolvedValue(key);
  m.sign.mockImplementation(async () => {
    m.active = 'other';
    return 'signed';
  });
  await expect(signReviewedAcross(signing, context, 'wallet', () => true)).rejects.toThrow(
    'session changed',
  );
  expect(key.every((v) => v === 0)).toBe(true);
  expect(m.submit).not.toHaveBeenCalled();
  m.active = 'wallet';
  m.sign.mockResolvedValue('signed');
  m.key.mockResolvedValue(new Uint8Array(32));
  m.submit.mockRejectedValue(new Error('ambiguous timeout'));
  await expect(signReviewedAcross(signing, context, 'wallet', () => true)).rejects.toThrow(
    'ambiguous timeout',
  );
  expect(m.submit).toHaveBeenCalledOnce();
});
it('snapshots consent before awaiting confirmation and rechecks expiry before key access', async () => {
  const { signing, context } = acrossExecutionFixture();
  const original = signing.review.calldata;
  m.key.mockResolvedValue(new Uint8Array(32));
  m.confirm.mockImplementation(async () => {
    signing.review.terms.recipient = context.signer;
    context.intent.amountRaw = '999';
    return true;
  });
  await signReviewedAcross(signing, context, 'wallet', () => true);
  expect(m.sign.mock.calls[1]?.[1].data).toBe(original);
  m.key.mockClear();
  m.sign.mockClear();
  m.submit.mockClear();
  const fresh = acrossExecutionFixture();
  const clock = vi.spyOn(Date, 'now');
  m.confirm.mockImplementation(async () => {
    clock.mockReturnValue(fresh.signing.review.expiresAtMs);
    return true;
  });
  try {
    await expect(
      signReviewedAcross(fresh.signing, fresh.context, 'wallet', () => true),
    ).rejects.toThrow('review');
    expect(m.key).not.toHaveBeenCalled();
    expect(m.submit).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});
