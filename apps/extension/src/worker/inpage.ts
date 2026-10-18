import { base58, base64 } from '@scure/base';
import { FROM_CONTENT, FROM_PAGE, type Namespace, type PageReply } from './protocol';

/**
 * What websites see: an EIP-1193 provider, announced with EIP-6963 (and set as
 * window.ethereum only when no other wallet has), and a Solana wallet registered with
 * the Wallet Standard. Runs in the page's own world, so it holds nothing secret: every
 * call goes to Honey, which asks you before anything is signed.
 */

declare const __HONEY_ICON__: string;
const ICON = __HONEY_ICON__ as `data:image/png;base64,${string}`;
const NAME = 'Honey';
/** EIP-6963's reverse-DNS id for this wallet. */
const RDNS = 'app.honeywallet';

// Transport

let nextId = 1;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
const listeners: Record<Namespace, Map<string, Set<(data: unknown) => void>>> = {
  evm: new Map(),
  solana: new Map(),
};

class ProviderRpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function call(namespace: Namespace, method: string, params?: unknown): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    window.postMessage(
      { source: FROM_PAGE, id, namespace, method, params },
      window.location.origin,
    );
  });
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data as (PageReply & { source?: string }) | undefined;
  if (data?.source !== FROM_CONTENT) return;
  if ('event' in data) {
    for (const listener of listeners[data.namespace]?.get(data.event) ?? []) {
      try {
        listener(data.data);
      } catch (error) {
        console.error(error);
      }
    }
    return;
  }
  const entry = waiting.get(data.id);
  if (!entry) return;
  waiting.delete(data.id);
  if ('error' in data) {
    entry.reject(new ProviderRpcError(data.error.code, data.error.message, data.error.data));
  } else entry.resolve(data.result);
});

const on = (namespace: Namespace, event: string, listener: (data: unknown) => void) => {
  const set = listeners[namespace].get(event) ?? new Set();
  set.add(listener);
  listeners[namespace].set(event, set);
  return () => set.delete(listener);
};

// EVM: EIP-1193

let chainId: string | null = null;
let accounts: string[] = [];

on('evm', 'chainChanged', (id) => {
  chainId = id as string;
});
on('evm', 'accountsChanged', (list) => {
  accounts = list as string[];
});

const evmListeners = new Map<string, Set<(...args: unknown[]) => void>>();
const fire = (event: string, ...args: unknown[]) => {
  for (const listener of evmListeners.get(event) ?? []) {
    try {
      listener(...args);
    } catch (error) {
      console.error(error);
    }
  }
};
on('evm', 'chainChanged', (id) => fire('chainChanged', id));
on('evm', 'accountsChanged', (list) => {
  fire('accountsChanged', list);
  if (!(list as string[]).length) fire('disconnect', new ProviderRpcError(4900, 'Disconnected'));
});

const provider = {
  isHoney: true,
  get chainId() {
    return chainId;
  },
  get selectedAddress() {
    return accounts[0] ?? null;
  },
  isConnected: () => true,
  async request(args: { method: string; params?: unknown[] | object }) {
    if (!args || typeof args.method !== 'string') {
      throw new ProviderRpcError(-32602, 'Invalid request');
    }
    const result = await call('evm', args.method, args.params);
    if (args.method === 'eth_chainId') chainId = result as string;
    if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') {
      accounts = result as string[];
    }
    return result;
  },
  /** Old sites call enable() instead of eth_requestAccounts. */
  enable() {
    return this.request({ method: 'eth_requestAccounts' });
  },
  on(event: string, listener: (...args: unknown[]) => void) {
    const set = evmListeners.get(event) ?? new Set();
    set.add(listener);
    evmListeners.set(event, set);
    return provider;
  },
  removeListener(event: string, listener: (...args: unknown[]) => void) {
    evmListeners.get(event)?.delete(listener);
    return provider;
  },
};
// Some libraries call `off` and `addListener`.
Object.assign(provider, { off: provider.removeListener, addListener: provider.on });

const info = Object.freeze({ uuid: crypto.randomUUID(), name: NAME, icon: ICON, rdns: RDNS });
const announce = () =>
  window.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', {
      detail: Object.freeze({ info, provider }),
    }),
  );
window.addEventListener('eip6963:requestProvider', announce);
announce();

// Don't push another wallet aside: sites that only read window.ethereum keep it.
if (!('ethereum' in window)) {
  Object.defineProperty(window, 'ethereum', { value: provider, configurable: true });
}

// Solana: Wallet Standard

const CHAIN = 'solana:mainnet';
const FEATURES = ['solana:signMessage', 'solana:signTransaction', 'solana:signAndSendTransaction'];

type Account = {
  address: string;
  publicKey: Uint8Array;
  chains: readonly string[];
  features: readonly string[];
};

let solanaAccounts: Account[] = [];
const changeListeners = new Set<(props: { accounts: Account[] }) => void>();

const accountFor = (address: string): Account =>
  Object.freeze({
    address,
    publicKey: base58.decode(address),
    chains: [CHAIN],
    features: FEATURES,
  });

function setSolana(address: string | null) {
  const next = address ? [accountFor(address)] : [];
  if (next[0]?.address === solanaAccounts[0]?.address) return;
  solanaAccounts = next;
  for (const listener of changeListeners) listener({ accounts: solanaAccounts });
}
on('solana', 'accountsChanged', (list) => setSolana((list as string[])[0] ?? null));

type Input = { account: Account; message?: Uint8Array; transaction?: Uint8Array };

/** Runs one approval per input, in order, as the standard expects. */
async function each<T>(inputs: Input[], run: (input: Input) => Promise<T>) {
  const out: T[] = [];
  for (const input of inputs) out.push(await run(input));
  return out;
}

const wallet = {
  version: '1.0.0' as const,
  name: NAME,
  icon: ICON,
  chains: [CHAIN],
  get accounts() {
    return solanaAccounts;
  },
  features: {
    'standard:connect': {
      version: '1.0.0',
      async connect(input?: { silent?: boolean }) {
        const { address } = (await call('solana', 'connect', { silent: !!input?.silent })) as {
          address: string | null;
        };
        setSolana(address);
        return { accounts: solanaAccounts };
      },
    },
    'standard:disconnect': {
      version: '1.0.0',
      async disconnect() {
        await call('solana', 'disconnect');
        setSolana(null);
      },
    },
    'standard:events': {
      version: '1.0.0',
      on(event: string, listener: (props: { accounts: Account[] }) => void) {
        if (event !== 'change') return () => {};
        changeListeners.add(listener);
        return () => changeListeners.delete(listener);
      },
    },
    'solana:signMessage': {
      version: '1.0.0',
      signMessage: (...inputs: Input[]) =>
        each(inputs, async ({ account, message }) => {
          const { signature } = (await call('solana', 'signMessage', {
            account: account.address,
            message: base64.encode(message ?? new Uint8Array()),
          })) as { signature: string };
          return { signedMessage: message, signature: base64.decode(signature) };
        }),
    },
    'solana:signTransaction': {
      version: '1.0.0',
      supportedTransactionVersions: ['legacy', 0],
      signTransaction: (...inputs: Input[]) =>
        each(inputs, async ({ account, transaction }) => {
          const { signedTransaction } = (await call('solana', 'signTransaction', {
            account: account.address,
            transaction: base64.encode(transaction ?? new Uint8Array()),
          })) as { signedTransaction: string };
          return { signedTransaction: base64.decode(signedTransaction) };
        }),
    },
    'solana:signAndSendTransaction': {
      version: '1.0.0',
      supportedTransactionVersions: ['legacy', 0],
      signAndSendTransaction: (...inputs: Input[]) =>
        each(inputs, async ({ account, transaction }) => {
          const { signature } = (await call('solana', 'signAndSendTransaction', {
            account: account.address,
            transaction: base64.encode(transaction ?? new Uint8Array()),
          })) as { signature: string };
          return { signature: base58.decode(signature) };
        }),
    },
  },
};

const register = ({ register }: { register: (w: typeof wallet) => void }) => register(wallet);
try {
  window.dispatchEvent(
    new CustomEvent('wallet-standard:register-wallet', {
      bubbles: false,
      cancelable: false,
      composed: false,
      detail: register,
    }),
  );
} catch (error) {
  console.error('Honey: couldn’t register with the Wallet Standard', error);
}
try {
  window.addEventListener('wallet-standard:app-ready', ((event: CustomEvent) =>
    register(event.detail)) as EventListener);
} catch (error) {
  console.error('Honey: couldn’t register with the Wallet Standard', error);
}
