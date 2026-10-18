import {
  deriveAddresses,
  mnemonicToSeed,
  privateKeyFor,
  signEvmMessage,
  signEvmTypedData,
  signSolanaMessage,
} from '@honey-wallet/keyring';
import { base58, base64 } from '@scure/base';
import SignClient from '@walletconnect/sign-client';
import { recoverMessageAddress, recoverTypedDataAddress, toHex } from 'viem';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The phone's WalletConnect code (src/lib/walletconnect.ts) against the real relay, with a
 * real dApp client on the other end. Needs the network and a project id, so it only runs
 * when asked: WC_E2E=1 EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID=… pnpm exec vitest run walletconnect
 * The approval screen is played by `approveNext`, signing as performApproval does.
 */
const RUN = process.env.WC_E2E === '1' && !!process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID;
const PHRASE = 'test test test test test test test test test test test junk';

const memory = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => memory.get(k) ?? null,
    setItem: async (k: string, v: string) => void memory.set(k, v),
    removeItem: async (k: string) => void memory.delete(k),
  },
}));
vi.mock('expo-crypto', () => ({
  getRandomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
}));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));
const answers: string[] = [];
vi.mock('expo-router', () => ({
  router: { push: () => setTimeout(() => void approveNext(), 50) },
}));

let approveNext: () => Promise<void> = async () => {};

describe.skipIf(!RUN)('WalletConnect on the phone (real relay)', () => {
  let dapp: InstanceType<typeof SignClient>;
  let topic = '';
  let evm = '';
  let solana = '';
  let decide: 'approve' | 'reject' = 'approve';

  beforeAll(async () => {
    const seed = await mnemonicToSeed(PHRASE);
    ({ evm, solana } = deriveAddresses(seed, 0));
    const wc = await import('@/lib/walletconnect');
    // What the approval screen does: answer the oldest request, signing with the key.
    approveNext = async () => {
      for (let next = wc.wcRouter.next(); next; next = wc.wcRouter.next()) {
        answers.push(next.kind);
        const p = next.params as Record<string, string>;
        if (decide === 'reject')
          wc.wcRouter.answer({ id: next.id, error: { code: 4001, message: 'No' } });
        else if (next.kind === 'connect')
          wc.wcRouter.answer({
            id: next.id,
            connect: { walletId: 'w1', walletName: 'Main', evm, solana },
          });
        else if (next.kind === 'evmSign')
          wc.wcRouter.answer({
            id: next.id,
            result: await signEvmMessage(privateKeyFor(seed, 'evm'), p.message as string),
          });
        else if (next.kind === 'evmTypedData')
          wc.wcRouter.answer({
            id: next.id,
            result: await signEvmTypedData(privateKeyFor(seed, 'evm'), p.data as string),
          });
        else if (next.kind === 'solanaSignMessage')
          wc.wcRouter.answer({
            id: next.id,
            result: {
              signature: base64.encode(
                signSolanaMessage(
                  privateKeyFor(seed, 'solana'),
                  base64.decode(p.message as string),
                ),
              ),
            },
          });
        else
          wc.wcRouter.answer({ id: next.id, error: { code: 4001, message: 'Not in this test' } });
      }
    };
    await wc.walletConnect();
    dapp = await SignClient.init({
      projectId: process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID,
      customStoragePrefix: `dapp-${Date.now()}`,
      metadata: {
        name: 'Honey test dApp',
        description: 'e2e',
        url: 'https://example.com',
        icons: [],
      },
    });
    const { uri, approval } = await dapp.connect({
      optionalNamespaces: {
        eip155: {
          chains: ['eip155:1', 'eip155:8453'],
          methods: ['personal_sign', 'eth_signTypedData_v4', 'eth_sign'],
          events: ['accountsChanged', 'chainChanged'],
        },
        solana: {
          chains: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
          methods: ['solana_signMessage'],
          events: [],
        },
      },
    });
    expect(wc.isWalletConnectUri(uri ?? '')).toBe(true);
    await wc.pairWalletConnect(uri as string);
    const session = await approval();
    topic = session.topic;
  }, 60_000);

  afterAll(async () => {
    await dapp?.disconnect({ topic, reason: { code: 6000, message: 'done' } }).catch(() => {});
  });

  const request = (chainId: string, method: string, params: unknown) =>
    dapp.request({ topic, chainId, request: { method, params } });

  it('connects with the wallet’s EVM and Solana accounts after approval', () => {
    const accounts = dapp.session.get(topic).namespaces;
    expect(accounts.eip155?.accounts).toContain(`eip155:1:${evm}`);
    expect(accounts.solana?.accounts).toContain(
      `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:${solana}`,
    );
    expect(answers[0]).toBe('connect');
  });

  it('signs personal_sign on Base, recoverable to the wallet', async () => {
    const message = 'Sign in to the test dApp';
    const signature = (await request('eip155:8453', 'personal_sign', [
      toHex(message),
      evm,
    ])) as `0x${string}`;
    expect(await recoverMessageAddress({ message, signature })).toBe(evm);
  }, 30_000);

  it('signs EIP-712 typed data', async () => {
    const typed = {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'chainId', type: 'uint256' },
        ],
        Note: [{ name: 'text', type: 'string' }],
      },
      primaryType: 'Note',
      domain: { name: 'Test', chainId: 1 },
      message: { text: 'hello' },
    } as const;
    const signature = (await request('eip155:1', 'eth_signTypedData_v4', [
      evm,
      JSON.stringify(typed),
    ])) as `0x${string}`;
    expect(await recoverTypedDataAddress({ ...typed, signature } as never)).toBe(evm);
  }, 30_000);

  it('refuses eth_sign and another address without asking', async () => {
    const before = answers.length;
    // eth_sign is never in the session, so the site's own SDK refuses it before it's sent.
    await expect(request('eip155:1', 'eth_sign', [evm, `0x${'00'.repeat(32)}`])).rejects.toThrow(
      /eth_sign/,
    );
    await expect(
      request('eip155:1', 'personal_sign', [
        '0x6869',
        '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB',
      ]),
    ).rejects.toMatchObject({ code: 4100 });
    expect(answers.length).toBe(before);
  }, 30_000);

  it('signs a Solana message (base58 in and out)', async () => {
    const message = new TextEncoder().encode('Sign in to the test dApp');
    const { signature } = (await request(
      'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      'solana_signMessage',
      {
        message: base58.encode(message),
        pubkey: solana,
      },
    )) as { signature: string };
    // ed25519 is deterministic: the right key gives exactly this signature.
    const seed = await mnemonicToSeed(PHRASE);
    expect(base58.decode(signature)).toEqual(
      signSolanaMessage(privateKeyFor(seed, 'solana'), message),
    );
  }, 30_000);

  it('passes a rejection back to the site', async () => {
    decide = 'reject';
    await expect(request('eip155:1', 'personal_sign', ['0x6869', evm])).rejects.toMatchObject({
      code: 4001,
    });
    decide = 'approve';
  }, 30_000);
});
