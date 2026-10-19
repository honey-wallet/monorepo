import { beforeEach, expect, it, vi } from 'vitest';
import { morphoFixture } from '../../../packages/api-client/src/fixtures/morpho';

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
vi.mock('@/lib/api', () => ({ api: { submitMorpho: m.submit } }));
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

import { earnRawAmount as morphoRawAmount } from '@/lib/earn-amount';
import { signReviewedMorpho } from '@/lib/morpho-execution';

beforeEach(() => {
  vi.resetAllMocks();
  const { context } = morphoFixture();
  m.token = 'token';
  m.active = 'wallet';
  m.profile = { wallet: { id: 'id', address: context.signer, chainId: 'eip155:31337' } };
  m.address.mockReturnValue(context.signer);
  m.confirm.mockResolvedValue(true);
  m.sign.mockResolvedValue('signed');
  m.submit.mockResolvedValue({});
});
it('parses exact decimal amounts without Number rounding', () => {
  expect(morphoRawAmount('9007199254.740993', 6)).toBe('9007199254740993');
  expect(morphoRawAmount('0.000000000000000001', 18)).toBe('1');
  expect(morphoRawAmount('0.000000000000000000000000000000000001', 36)).toBe('1');
  for (const bad of ['0', '-1', '1e6', '01', '1.0000001'])
    expect(() => morphoRawAmount(bad, 6)).toThrow();
});

it('requires redemption consent before prompting and keeps reviewed inputs stable during confirmation', async () => {
  const { signing, context } = morphoFixture('redeem');
  context.intent.acknowledgeUnprotectedOutput = false;
  await expect(signReviewedMorpho(signing, context, 'wallet', () => true)).rejects.toThrow(
    'reviewed operation',
  );
  expect(m.confirm).not.toHaveBeenCalled();
  context.intent.acknowledgeUnprotectedOutput = true;
  const original = signing.prepared.plan.steps.at(-1)?.data;
  m.confirm.mockImplementation(async () => {
    context.intent.amountRaw = '999';
    signing.prepared.plan.steps = [];
    return true;
  });
  m.key.mockResolvedValue(new Uint8Array(32));
  await signReviewedMorpho(signing, context, 'wallet', () => true);
  expect(m.sign.mock.calls.at(-1)?.[1].data).toBe(original);
  expect(m.submit).toHaveBeenCalledOnce();
});
it('confirms ownership before loading keys and wipes them before submission', async () => {
  const key = new Uint8Array(32).fill(7);
  m.key.mockResolvedValue(key);
  m.submit.mockImplementation(async () => {
    expect(key.every((v) => v === 0)).toBe(true);
  });
  const { signing, context } = morphoFixture();
  await signReviewedMorpho(signing, context, 'wallet', () => true);
  expect(m.confirm).toHaveBeenCalledWith('Confirm Morpho transaction', true);
  expect(m.sign).toHaveBeenCalledTimes(2);
  expect(m.submit).toHaveBeenCalledOnce();
});
it('rejects owner cancellation and session/wallet changes before private-key access', async () => {
  const { signing, context } = morphoFixture();
  m.confirm.mockResolvedValue(false);
  await expect(signReviewedMorpho(signing, context, 'wallet', () => true)).rejects.toThrow(
    'cancelled',
  );
  expect(m.key).not.toHaveBeenCalled();
  m.confirm.mockImplementation(async () => {
    m.token = 'changed';
    return true;
  });
  await expect(signReviewedMorpho(signing, context, 'wallet', () => true)).rejects.toThrow(
    'session changed',
  );
  expect(m.key).not.toHaveBeenCalled();
  expect(m.submit).not.toHaveBeenCalled();
});
it('discards a partial bundle and wipes keys if context changes during signing', async () => {
  const { signing, context } = morphoFixture();
  const key = new Uint8Array(32).fill(7);
  m.key.mockResolvedValue(key);
  m.sign.mockImplementation(async () => {
    m.active = 'other';
    return 'signed';
  });
  await expect(signReviewedMorpho(signing, context, 'wallet', () => true)).rejects.toThrow(
    'session changed',
  );
  expect(key.every((v) => v === 0)).toBe(true);
  expect(m.sign).toHaveBeenCalledOnce();
  expect(m.submit).not.toHaveBeenCalled();
});
it('rejects altered calldata before prompting and never automatically retries submission', async () => {
  const { signing, context } = morphoFixture();
  const changed = structuredClone(signing);
  const first = changed.prepared.plan.steps[0];
  if (!first) throw new Error('missing fixture');
  first.data = '0x12345678';
  await expect(signReviewedMorpho(changed, context, 'wallet', () => true)).rejects.toThrow(
    'reviewed operation',
  );
  expect(m.confirm).not.toHaveBeenCalled();
  m.key.mockResolvedValue(new Uint8Array(32));
  m.submit.mockRejectedValue(new Error('ambiguous timeout'));
  await expect(signReviewedMorpho(signing, context, 'wallet', () => true)).rejects.toThrow(
    'ambiguous timeout',
  );
  expect(m.submit).toHaveBeenCalledOnce();
});
