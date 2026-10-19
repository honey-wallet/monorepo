import type { Approval, Site } from '@honey-wallet/extension/protocol';
import { type Caller, createRouter } from '@honey-wallet/extension/router';
import { EVM_NETWORKS, readSolanaTransaction } from '@honey-wallet/keyring';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { type IWalletKit, WalletKit, type WalletKitTypes } from '@reown/walletkit';
import { base58, base64 } from '@scure/base';
import { Core } from '@walletconnect/core';
import { buildApprovedNamespaces, getSdkError } from '@walletconnect/utils';
import { getRandomBytes } from 'expo-crypto';
import { router as nav } from 'expo-router';
import { requestJsonRpc } from '@/lib/json-rpc';
import { showToast } from '@/lib/toast';

/**
 * Websites on the phone, through WalletConnect: scan a site's QR (or paste its link) and
 * it can ask to connect, sign and send. Every request goes through the same router as
 * Honey for Chrome (apps/extension/src/worker/router.ts), so the same checks apply (the
 * connected address only, never eth_sign, readable text only for Solana messages), and
 * the same approval screen answers it (app/(connect)/approve.tsx).
 *
 * A site is keyed by its origin plus the proposal, so two sessions from one site stay
 * separate. Its origin is the one WalletConnect's Verify service confirms when it can;
 * otherwise the site's own claim, marked unverified on every request.
 */

const PROJECT_ID = process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID;

/** WalletConnect's id for Solana mainnet (CAIP-2: the genesis hash, shortened). */
const SOLANA_CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const EVM_METHODS = [
  'personal_sign',
  'eth_signTypedData_v4',
  'eth_signTypedData',
  'eth_sendTransaction',
  'wallet_switchEthereumChain',
];
const SOLANA_METHODS = [
  'solana_signMessage',
  'solana_signTransaction',
  'solana_signAndSendTransaction',
];

const RPC_TIMEOUT_MS = 15_000;
const RPC_MAX_RESPONSE_BYTES = 1_048_576;
const MAX_WALLETCONNECT_REQUEST_BYTES = 128 * 1024;
const MAX_WALLETCONNECT_REQUEST_NODES = 4_096;
const MAX_WALLETCONNECT_REQUEST_DEPTH = 32;
const utf8 = new TextEncoder();

const STORE = { topics: 'honey.wc.topics' };

type Entry = { key: string; caller: Caller };
let topics: Record<string, Entry> = {};
let showing = false;

/** Bounds an untrusted dApp request before it is decoded, queued or shown to an owner. */
export function isBoundedWalletConnectRequest(request: unknown): boolean {
  if (!request || typeof request !== 'object') return false;
  const candidate = request as { method?: unknown; params?: unknown };
  if (typeof candidate.method !== 'string' || candidate.method.length > 128) return false;

  let bytes = 0;
  let nodes = 0;
  const seen = new Set<object>();
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: candidate.method, depth: 0 },
    { value: candidate.params, depth: 0 },
  ];
  const push = (value: unknown, depth: number) => {
    if (nodes + stack.length >= MAX_WALLETCONNECT_REQUEST_NODES) return false;
    stack.push({ value, depth });
    return true;
  };
  const addString = (value: string) => {
    if (value.length > MAX_WALLETCONNECT_REQUEST_BYTES) return false;
    bytes += utf8.encode(value).byteLength;
    return bytes <= MAX_WALLETCONNECT_REQUEST_BYTES;
  };

  try {
    while (stack.length) {
      const next = stack.pop();
      if (!next || ++nodes > MAX_WALLETCONNECT_REQUEST_NODES) return false;
      const { value, depth } = next;
      if (depth > MAX_WALLETCONNECT_REQUEST_DEPTH) return false;
      if (value === null) {
        bytes += 4;
      } else if (typeof value === 'string') {
        if (!addString(value)) return false;
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        bytes += 16;
      } else if (Array.isArray(value)) {
        if (seen.has(value) || value.length > MAX_WALLETCONNECT_REQUEST_NODES) return false;
        seen.add(value);
        bytes += 2;
        for (const item of value) if (!push(item, depth + 1)) return false;
      } else if (typeof value === 'object') {
        if (seen.has(value)) return false;
        seen.add(value);
        bytes += 2;
        for (const key in value) {
          if (!Object.hasOwn(value, key)) continue;
          if (!addString(key)) return false;
          bytes += 2;
          if (!push((value as Record<string, unknown>)[key], depth + 1)) return false;
        }
      } else {
        return false;
      }
      if (bytes > MAX_WALLETCONNECT_REQUEST_BYTES) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const router = createRouter({
  load: async <T>(key: string) => {
    const text = await AsyncStorage.getItem(`honey.wc.${key}`);
    return text ? (JSON.parse(text) as T) : undefined;
  },
  save: (key, value) => AsyncStorage.setItem(`honey.wc.${key}`, JSON.stringify(value)),
  openApprovals: async () => {
    if (!showing) nav.push('/approve');
  },
  rpc: requestRpc,
  // WalletConnect sends its own events (accountsChanged) through the session.
  emit: () => {},
  badge: () => {},
  newId: () => Array.from(getRandomBytes(12), (b) => b.toString(16).padStart(2, '0')).join(''),
  now: () => Date.now(),
});

/** Bound provider response memory and total network wait before handing data to the router. */
export async function requestRpc(
  url: string,
  method: string,
  params: unknown,
  fetcher: typeof fetch = fetch,
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<unknown> {
  return requestJsonRpc(url, method, params, {
    fetcher,
    timeoutMs,
    maxResponseBytes: RPC_MAX_RESPONSE_BYTES,
  });
}

const saveTopics = () => AsyncStorage.setItem(STORE.topics, JSON.stringify(topics));

const verifiedOf = (
  context: { verified?: { validation?: string; isScam?: boolean } } | undefined,
) =>
  (context?.verified?.isScam
    ? 'scam'
    : context?.verified?.validation === 'VALID'
      ? 'valid'
      : context?.verified?.validation === 'INVALID'
        ? 'invalid'
        : 'unknown') as NonNullable<Approval['verified']>;

function originOf(proposal: WalletKitTypes.SessionProposal) {
  const verified = proposal.verifyContext?.verified;
  const claimed = proposal.params.proposer.metadata.url;
  const raw = verified?.validation === 'VALID' && verified.origin ? verified.origin : claimed;
  try {
    return new URL(raw).origin;
  } catch {
    return 'https://unknown.site';
  }
}

const providerError = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error && 'message' in error
    ? {
        code: Number((error as { code: unknown }).code),
        message: String((error as { message: unknown }).message),
      }
    : { code: -32603, message: 'Something went wrong in Honey.' };

let kit: Promise<IWalletKit | null> | null = null;

/** Starts WalletConnect once (after the app's wallets load); null when there's no project id. */
export function walletConnect() {
  if (!kit) kit = start();
  return kit;
}

async function start(): Promise<IWalletKit | null> {
  if (!PROJECT_ID) return null;
  topics = JSON.parse((await AsyncStorage.getItem(STORE.topics)) ?? '{}');
  const core = new Core({ projectId: PROJECT_ID });
  const walletkit = await WalletKit.init({
    core,
    metadata: {
      // name: 'Honey',
      name: 'Honey Wallet',
      description: 'All your crypto, one wallet.',
      url: 'https://honeywallet.app',
      icons: ['https://honeywallet.app/icon.png'],
    },
  });

  walletkit.on('session_proposal', async (proposal) => {
    const { id, params } = proposal;
    const wanted = { ...params.optionalNamespaces, ...params.requiredNamespaces };
    const namespace = 'eip155' in wanted ? 'evm' : 'solana' in wanted ? 'solana' : null;
    if (!namespace) {
      await walletkit.rejectSession({ id, reason: getSdkError('UNSUPPORTED_CHAINS') });
      return;
    }
    const key = `${originOf(proposal)}#wc-${id}`;
    const caller: Caller = {
      icon: params.proposer.metadata.icons?.[0],
      verified: verifiedOf(proposal.verifyContext),
    };
    try {
      await router.fromPage(key, caller, {
        id: 0,
        namespace,
        method: namespace === 'evm' ? 'eth_requestAccounts' : 'connect',
        params: namespace === 'evm' ? [] : {},
      });
      const site = (await router.sites()).find((s) => s.origin === key);
      if (!site) throw new Error('Not connected');
      const evmChains = EVM_NETWORKS.map((n) => `eip155:${n.chainId}`);
      const namespaces = buildApprovedNamespaces({
        proposal: params,
        supportedNamespaces: {
          ...(site.evm
            ? {
                eip155: {
                  chains: evmChains,
                  methods: EVM_METHODS,
                  events: ['accountsChanged', 'chainChanged'],
                  accounts: evmChains.map((c) => `${c}:${site.evm}`),
                },
              }
            : {}),
          ...(site.solana
            ? {
                solana: {
                  chains: [SOLANA_CHAIN],
                  methods: SOLANA_METHODS,
                  events: [],
                  accounts: [`${SOLANA_CHAIN}:${site.solana}`],
                },
              }
            : {}),
        },
      });
      const session = await walletkit.approveSession({ id, namespaces });
      topics[session.topic] = { key, caller };
      await saveTopics();
      showToast(`Connected to ${new URL(key).host}`);
    } catch (error) {
      await router.disconnect(key);
      const rejected = providerError(error).code === 4001;
      await walletkit
        .rejectSession({
          id,
          reason: getSdkError(rejected ? 'USER_REJECTED' : 'UNSUPPORTED_NAMESPACE_KEY'),
        })
        .catch(() => {});
      if (!rejected) showToast('Couldn’t connect to that site');
    }
  });

  walletkit.on('session_request', async (event) => {
    const { topic, id, params } = event;
    const entry = topics[topic];
    const respond = (
      response: { result: unknown } | { error: { code: number; message: string } },
    ) => walletkit.respondSessionRequest({ topic, response: { id, jsonrpc: '2.0', ...response } });
    if (!entry) {
      await respond({ error: { code: 4100, message: 'This session isn’t connected to Honey.' } });
      return;
    }
    try {
      await respond({ result: await answer(entry, params.chainId, params.request) });
    } catch (error) {
      await respond({ error: providerError(error) });
    }
  });

  walletkit.on('session_delete', async ({ topic }) => {
    const entry = topics[topic];
    if (!entry) return;
    delete topics[topic];
    await saveTopics();
    await router.disconnect(entry.key);
  });

  return walletkit;
}

/** One request, through the shared router, translated to and from WalletConnect's shapes. */
async function answer(entry: Entry, chainId: string, request: { method: string; params: unknown }) {
  if (!isBoundedWalletConnectRequest(request)) {
    throw { code: -32600, message: 'WalletConnect request is too large or complex.' };
  }
  const { key, caller } = entry;
  if (chainId.startsWith('eip155:')) {
    await router.pinChain(key, Number(chainId.slice('eip155:'.length)));
    return router.fromPage(key, caller, {
      id: 0,
      namespace: 'evm',
      method: request.method,
      params: request.params,
    });
  }
  if (chainId !== SOLANA_CHAIN)
    throw { code: 4902, message: 'Honey doesn’t support this network yet.' };
  const p = (request.params ?? {}) as { message?: string; pubkey?: string; transaction?: string };
  const site = (await router.sites()).find((s) => s.origin === key);
  const account = p.pubkey ?? site?.solana ?? '';
  switch (request.method) {
    case 'solana_signMessage': {
      // WalletConnect sends the message as base58; the router takes base64.
      const message = base64.encode(base58.decode(p.message ?? ''));
      const { signature } = (await router.fromPage(key, caller, {
        id: 0,
        namespace: 'solana',
        method: 'signMessage',
        params: { account, message },
      })) as { signature: string };
      return { signature: base58.encode(base64.decode(signature)) };
    }
    case 'solana_signTransaction': {
      const { signedTransaction } = (await router.fromPage(key, caller, {
        id: 0,
        namespace: 'solana',
        method: 'signTransaction',
        params: { account, transaction: p.transaction },
      })) as { signedTransaction: string };
      const bytes = base64.decode(signedTransaction);
      const read = readSolanaTransaction(bytes);
      const at = read.signatureAt(read.signers.indexOf(account));
      return {
        signature: base58.encode(bytes.subarray(at, at + 64)),
        transaction: signedTransaction,
      };
    }
    case 'solana_signAndSendTransaction':
      return router.fromPage(key, caller, {
        id: 0,
        namespace: 'solana',
        method: 'signAndSendTransaction',
        params: { account, transaction: p.transaction },
      });
    default:
      throw { code: 4200, message: 'Honey doesn’t support this request.' };
  }
}

/** A `wc:` link from the scanner or the clipboard. */
export async function pairWalletConnect(uri: string) {
  const walletkit = await walletConnect();
  if (!walletkit) throw new Error('WalletConnect isn’t set up in this build');
  await walletkit.pair({ uri });
}

export const isWalletConnectUri = (text: string) => /^wc:[0-9a-f]{64}@2\?/i.test(text.trim());

// What the approval screen and Settings › Connected apps use (lib/dapp.ts).

export const wcRouter = router;

export function setApprovalShowing(value: boolean) {
  showing = value;
}

export async function disconnectApp(origin: string) {
  const walletkit = await walletConnect();
  for (const [topic, entry] of Object.entries(topics)) {
    if (entry.key !== origin) continue;
    await walletkit
      ?.disconnectSession({ topic, reason: getSdkError('USER_DISCONNECTED') })
      .catch(() => {});
    delete topics[topic];
  }
  await saveTopics();
  await router.disconnect(origin);
}

export async function forgetApps() {
  for (const site of await router.sites()) await disconnectApp(site.origin);
  await router.forgetAll();
}

export type { Site };
