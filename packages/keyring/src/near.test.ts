import { bytesToHex } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';
import { describe, expect, it, vi } from 'vitest';
import vector from './fixtures/near.json';
import { deriveAddresses, mnemonicToSeed, privateKeyFor } from './index';
import {
  createNearClient,
  createNearRpc,
  encodeNearTransfer,
  formatNearAmount,
  isNearAccountId,
  NearRpcError,
  type NearTransfer,
  nearPublicKey,
  nearTransferOutcome,
  parseNearAmount,
  signNearTransfer,
} from './near';

const signer = vector.accounts[0]?.address as string;
const blockHash = base58.encode(new Uint8Array(32).fill(vector.transfer.blockHashBytes));
const transaction: NearTransfer = {
  network: 'mainnet',
  signerId: signer,
  receiverId: vector.transfer.receiverId,
  amount: BigInt(vector.transfer.amount),
  nonce: BigInt(vector.transfer.nonce),
  blockHash,
  preparedAt: 0,
};
const unknownAccount = () => new NearRpcError({ cause: { name: 'UNKNOWN_ACCOUNT' } });
const funded = {
  amount: '2000000000000000000000000',
  locked: '0',
  storage_usage: 182,
  block_hash: blockHash,
};
function mockRpc(
  overrides: {
    account?: unknown;
    access?: unknown;
    config?: unknown;
    missingRecipient?: boolean;
  } = {},
) {
  return vi.fn(async (method: string, params: unknown) => {
    const p = params as Record<string, unknown>;
    if (method === 'EXPERIMENTAL_protocol_config')
      return (
        overrides.config ?? {
          chain_id: 'mainnet',
          runtime_config: { storage_amount_per_byte: '10000000000000000000' },
        }
      );
    if (p.request_type === 'view_access_key')
      return (
        overrides.access ?? {
          nonce: 123,
          permission: 'FullAccess',
          block_hash: blockHash,
        }
      );
    if (p.account_id !== signer && overrides.missingRecipient) throw unknownAccount();
    return overrides.account ?? funded;
  });
}

describe('NEAR reference vectors', () => {
  it('matches the official seed phrase library for multiple accounts', async () => {
    const seed = await mnemonicToSeed(vector.phrase);
    for (const account of vector.accounts) {
      expect(deriveAddresses(seed, account.index).near).toBe(account.address);
      expect(nearPublicKey(account.address)).toBe(account.publicKey);
    }
  });
  it('matches the official SDK Borsh bytes and signature exactly', async () => {
    const seed = await mnemonicToSeed(vector.phrase);
    const key = privateKeyFor(seed, 'near');
    expect(bytesToHex(encodeNearTransfer(transaction))).toBe(vector.transfer.unsignedHex);
    expect(signNearTransfer(key, transaction).signedTransaction).toBe(vector.transfer.signedBase64);
    expect(() => signNearTransfer(privateKeyFor(seed, 'near', 1), transaction)).toThrow(
      'does not match',
    );
  });
  it.each([-1, 0.5, NaN, 0x80000000])('rejects an invalid account index %s', async (index) => {
    expect(() => privateKeyFor(new Uint8Array(64), 'near', index)).toThrow('account index');
  });
});

describe('NEAR amounts and accounts', () => {
  it.each(['alice.near', 'a-b_c.near', signer, 'aa'])('accepts %s', (id) => {
    expect(isNearAccountId(id)).toBe(true);
  });
  it.each([
    'A.near',
    'a',
    '-alice',
    'alice..near',
    'alice_-near',
    'alice.',
    'a'.repeat(65),
    ' alice.near',
    'alice/near',
  ])('rejects %s', (id) => {
    expect(isNearAccountId(id)).toBe(false);
  });
  it('keeps all 24 decimals without floating point rounding', () => {
    expect(parseNearAmount('0.000000000000000000000001')).toBe(1n);
    expect(formatNearAmount(1n)).toBe('0.000000000000000000000001');
    expect(formatNearAmount(parseNearAmount('1.234567890123456789012345'))).toBe(
      '1.234567890123456789012345',
    );
    expect(formatNearAmount(0n)).toBe('0');
  });
  it.each([
    '0',
    '-1',
    '01',
    '1e3',
    'NaN',
    'Infinity',
    '1,5',
    '1.',
    '0.0000000000000000000000001',
    '9'.repeat(40),
  ])('rejects amount %s', (amount) => {
    expect(() => parseNearAmount(amount)).toThrow();
  });
  it('bounds transfer integers and validates the hash and destination', () => {
    for (const change of [
      { nonce: 1n << 64n },
      { amount: 1n << 128n },
      { amount: 0n },
      { blockHash: '111' },
      { receiverId: signer },
    ])
      expect(() => encodeNearTransfer({ ...transaction, ...change })).toThrow();
  });
});

describe('NEAR RPC preparation', () => {
  it('reserves storage and fees and builds only a native transfer', async () => {
    const rpc = mockRpc();
    const client = createNearClient('mainnet', rpc);
    expect(await client.balance(signer)).toEqual({
      amount: 2n * 10n ** 24n,
      available: 198818n * 10n ** 19n,
      exists: true,
    });
    expect(await client.prepare(signer, 'alice.near', '1')).toMatchObject({
      signerId: signer,
      receiverId: 'alice.near',
      nonce: 124n,
      amount: 10n ** 24n,
      blockHash,
    });
    expect(rpc).toHaveBeenCalledWith(
      'query',
      expect.objectContaining({
        request_type: 'view_access_key',
        public_key: vector.accounts[0]?.publicKey,
      }),
    );
  });
  it('counts staked balance toward storage without making it spendable', async () => {
    const client = createNearClient(
      'mainnet',
      mockRpc({ account: { ...funded, locked: '1000000000000000000000000' } }),
    );
    expect((await client.balance(signer)).available).toBe(199n * 10n ** 22n);
  });
  it('reports an uncreated account as zero but surfaces transport failures', async () => {
    expect(
      await createNearClient('mainnet', async () => {
        throw unknownAccount();
      }).balance(signer),
    ).toEqual({ amount: 0n, available: 0n, exists: false });
    await expect(
      createNearClient('mainnet', async () => {
        throw new Error('offline');
      }).balance(signer),
    ).rejects.toThrow('offline');
  });
  it('allows funding an implicit account but rejects missing named accounts', async () => {
    const client = createNearClient('mainnet', mockRpc({ missingRecipient: true }));
    await expect(
      client.prepare(signer, vector.accounts[1]?.address as string, '1'),
    ).resolves.toBeDefined();
    await expect(client.prepare(signer, 'missing.near', '1')).rejects.toThrow('does not exist');
  });
  it('rejects insufficient balances, function-call keys, wrong networks, and unsafe nonces', async () => {
    await expect(
      createNearClient('mainnet', mockRpc()).prepare(signer, 'alice.near', '2'),
    ).rejects.toThrow('Insufficient');
    await expect(
      createNearClient(
        'mainnet',
        mockRpc({ access: { nonce: 1, permission: { FunctionCall: {} }, block_hash: blockHash } }),
      ).prepare(signer, 'alice.near', '1'),
    ).rejects.toThrow('full access');
    await expect(createNearClient('testnet', mockRpc()).balance(signer)).rejects.toThrow(
      'Wrong NEAR network',
    );
    await expect(
      createNearClient('mainnet', mockRpc()).prepare(signer, 'alice.testnet', '1'),
    ).rejects.toThrow('another NEAR network');
    await expect(
      createNearClient(
        'mainnet',
        mockRpc({
          access: {
            nonce: Number.MAX_SAFE_INTEGER + 1,
            permission: 'FullAccess',
            block_hash: blockHash,
          },
        }),
      ).prepare(signer, 'alice.near', '1'),
    ).rejects.toThrow('integer');
  });
  it('uses the selected RPC and sends only the signed transaction', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ result: { final_execution_status: 'NONE' } })),
      );
    await createNearClient('testnet', createNearRpc('testnet', fetcher)).submit('signed-bytes');
    expect(fetcher).toHaveBeenCalledWith(
      'https://rpc.testnet.near.org',
      expect.objectContaining({
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'honey-near',
          method: 'send_tx',
          params: { signed_tx_base64: 'signed-bytes', wait_until: 'FINAL' },
        }),
      }),
    );
  });
  it('fails closed on HTTP failures, malformed responses and structured RPC errors', async () => {
    for (const response of [
      new Response('', { status: 503 }),
      new Response('{}'),
      new Response(JSON.stringify({ error: { cause: { name: 'INVALID_TRANSACTION' } } })),
    ])
      await expect(
        createNearRpc('mainnet', vi.fn().mockResolvedValue(response))('query', {}),
      ).rejects.toThrow();
  });
});

it('requires finality, matching hash/signer, and successful execution', () => {
  const result = {
    final_execution_status: 'FINAL',
    transaction: { hash: 'hash', signer_id: signer },
    status: { SuccessValue: '' },
  };
  expect(nearTransferOutcome(result, 'hash', signer)).toBe('success');
  expect(
    nearTransferOutcome(
      { ...result, final_execution_status: 'EXECUTED_OPTIMISTIC' },
      'hash',
      signer,
    ),
  ).toBe('pending');
  expect(nearTransferOutcome({ ...result, status: { Failure: {} } }, 'hash', signer)).toBe(
    'failure',
  );
  expect(() => nearTransferOutcome(result, 'other', signer)).toThrow('mismatch');
  expect(() => nearTransferOutcome(result, 'hash', 'other.near')).toThrow('mismatch');
});
