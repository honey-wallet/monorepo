import { DEFAULT_CHAIN_ID, EVM_NETWORKS, evmNetwork } from '@honey-wallet/keyring/networks';
import {
  type Answer,
  type Approval,
  type ApprovalKind,
  ERR,
  type PageReply,
  type PageRequest,
  type ProviderError,
  type Site,
  STORAGE,
} from './protocol';

/**
 * The background worker's logic, with Chrome's APIs passed in so it can be tested.
 * Websites call `fromPage`; Honey's approval window calls `next` and `answer`.
 */

export type RouterDeps = {
  load: <T>(key: string) => Promise<T | undefined>;
  save: (key: string, value: unknown) => Promise<void>;
  /** Opens (or focuses) the approval window. */
  openApprovals: () => Promise<void>;
  /** A JSON-RPC call to a public node. Throws a ProviderError for an RPC error. */
  rpc: (url: string, method: string, params: unknown) => Promise<unknown>;
  /** Sends an event to every tab of a site. */
  emit: (origin: string, reply: PageReply) => void;
  badge: (count: number) => void;
  newId: () => string;
  now: () => number;
};

/** Reads that go straight to the network's public node: no keys, nothing to approve. */
const READ_ONLY = new Set([
  'eth_blockNumber',
  'eth_call',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'eth_getBalance',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getLogs',
  'eth_getProof',
  'eth_getStorageAt',
  'eth_getTransactionByHash',
  'eth_getTransactionCount',
  'eth_getTransactionReceipt',
  'eth_maxPriorityFeePerGas',
  'eth_syncing',
  'web3_clientVersion',
]);

/** Requests one site may have waiting at once. */
const MAX_PENDING_PER_SITE = 5;

const fail = (error: ProviderError, message?: string): never => {
  throw message ? { ...error, message } : error;
};

const isAddress = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const isHex = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const toHex = (n: number) => `0x${n.toString(16)}`;

type Pending = { approval: Approval; settle: (answer: Answer) => void };

export function createRouter(deps: RouterDeps) {
  const pending = new Map<string, Pending>();
  let waiting = 0;

  const refreshBadge = () => deps.badge(pending.size + waiting);

  // Sites

  const sites = async () => (await deps.load<Record<string, Site>>(STORAGE.sites)) ?? {};
  const siteOf = async (origin: string) => (await sites())[origin];
  const saveSite = async (origin: string, site: Site | null) => {
    const all = await sites();
    if (site) all[origin] = site;
    else delete all[origin];
    await deps.save(STORAGE.sites, all);
  };
  const chainOf = async (origin: string) =>
    (await siteOf(origin))?.chainId ??
    (await deps.load<Record<string, number>>(STORAGE.chains))?.[origin] ??
    DEFAULT_CHAIN_ID;

  const announce = (origin: string, site: Site | null) => {
    deps.emit(origin, {
      event: 'accountsChanged',
      namespace: 'evm',
      data: site?.evm ? [site.evm] : [],
    });
    deps.emit(origin, {
      event: 'accountsChanged',
      namespace: 'solana',
      data: site?.solana ? [site.solana] : [],
    });
  };

  async function setChain(origin: string, chainId: number) {
    const site = await siteOf(origin);
    if (site) await saveSite(origin, { ...site, chainId });
    else {
      const chains = (await deps.load<Record<string, number>>(STORAGE.chains)) ?? {};
      await deps.save(STORAGE.chains, { ...chains, [origin]: chainId });
    }
    deps.emit(origin, { event: 'chainChanged', namespace: 'evm', data: toHex(chainId) });
  }

  async function disconnect(origin: string) {
    const site = await siteOf(origin);
    if (!site) return;
    // The site stays on its network if it connects again.
    const chains = (await deps.load<Record<string, number>>(STORAGE.chains)) ?? {};
    await deps.save(STORAGE.chains, { ...chains, [origin]: site.chainId });
    await saveSite(origin, null);
    announce(origin, null);
  }

  // Approvals

  function ask(
    kind: ApprovalKind,
    origin: string,
    icon: string | undefined,
    site: Site | undefined,
    params: unknown,
  ): Promise<Answer> {
    const mine = [...pending.values()].filter((p) => p.approval.origin === origin);
    if (kind === 'connect' && mine.some((p) => p.approval.kind === 'connect')) fail(ERR.pending);
    if (mine.length >= MAX_PENDING_PER_SITE) fail(ERR.busy);
    const approval: Approval = {
      id: deps.newId(),
      kind,
      origin,
      icon,
      site,
      params,
      createdAt: deps.now(),
    };
    return new Promise<Answer>((settle) => {
      pending.set(approval.id, { approval, settle });
      refreshBadge();
      void deps.openApprovals();
    });
  }

  /** Waits for the user, then returns the result or throws their refusal. */
  async function askFor(...args: Parameters<typeof ask>) {
    const answer = await ask(...args);
    if ('error' in answer) throw answer.error;
    return answer;
  }

  async function connect(origin: string, icon: string | undefined, namespace: 'evm' | 'solana') {
    const answer = await askFor('connect', origin, icon, undefined, { namespace });
    if (!('connect' in answer)) return fail(ERR.internal);
    const picked = answer.connect;
    if (!(namespace === 'evm' ? picked.evm : picked.solana)) fail(ERR.unauthorized);
    const site: Site = {
      origin,
      ...picked,
      chainId: await chainOf(origin),
      connectedAt: deps.now(),
    };
    await saveSite(origin, site);
    announce(origin, site);
    return site;
  }

  const resultOf = (answer: Answer) => ('result' in answer ? answer.result : fail(ERR.internal));

  // EVM (EIP-1193)

  async function evm(origin: string, icon: string | undefined, method: string, params: unknown) {
    const args = Array.isArray(params) ? params : [];
    const site = await siteOf(origin);
    const connected = site?.evm ? site : undefined;
    /** The connected site, or a 4100 when the site isn't connected or names another address. */
    const authorized = (address?: unknown) => {
      if (!connected?.evm) return fail(ERR.unauthorized);
      if (address !== undefined && !(isAddress(address) && sameAddress(address, connected.evm))) {
        fail(ERR.unauthorized, 'That address isn’t connected to this site.');
      }
      return connected;
    };

    switch (method) {
      case 'eth_chainId':
        return toHex(await chainOf(origin));
      case 'net_version':
        return String(await chainOf(origin));
      case 'eth_accounts':
        return connected?.evm ? [connected.evm] : [];
      case 'eth_requestAccounts': {
        if (connected?.evm) return [connected.evm];
        const added = await connect(origin, icon, 'evm');
        return [added.evm];
      }
      case 'wallet_requestPermissions': {
        if (!connected?.evm) await connect(origin, icon, 'evm');
        return [{ parentCapability: 'eth_accounts' }];
      }
      case 'wallet_getPermissions':
        return connected?.evm
          ? [
              {
                parentCapability: 'eth_accounts',
                caveats: [{ type: 'restrictReturnedAccounts', value: [connected.evm] }],
              },
            ]
          : [];
      case 'wallet_revokePermissions':
        await disconnect(origin);
        return null;
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain': {
        const wanted = (args[0] as { chainId?: unknown } | undefined)?.chainId;
        if (!isHex(wanted)) return fail(ERR.invalid);
        const chainId = Number.parseInt(wanted, 16);
        if (!evmNetwork(chainId)) return fail(ERR.unknownChain);
        if (chainId === (await chainOf(origin))) return null;
        await askFor('switchChain', origin, icon, site, chainId);
        await setChain(origin, chainId);
        return null;
      }
      case 'personal_sign': {
        // [message, address]; some sites send them the other way round.
        let [message, address] = args as unknown[];
        if (isAddress(message) && !isAddress(address)) [message, address] = [address, message];
        if (typeof message !== 'string') return fail(ERR.invalid);
        const from = authorized(address);
        return resultOf(await askFor('evmSign', origin, icon, from, { message }));
      }
      case 'eth_signTypedData_v4':
      case 'eth_signTypedData_v3': {
        const [address, data] = args as unknown[];
        const from = authorized(address);
        const json = typeof data === 'string' ? data : JSON.stringify(data);
        if (!json) return fail(ERR.invalid);
        return resultOf(await askFor('evmTypedData', origin, icon, from, { data: json }));
      }
      case 'eth_sendTransaction': {
        const tx = args[0] as Record<string, unknown> | undefined;
        if (!tx || typeof tx !== 'object') return fail(ERR.invalid);
        const from = authorized(tx.from ?? connected?.evm);
        if (tx.to !== undefined && tx.to !== null && !isAddress(tx.to)) return fail(ERR.invalid);
        for (const field of ['value', 'data', 'gas', 'chainId'] as const) {
          if (tx[field] !== undefined && !isHex(tx[field])) return fail(ERR.invalid);
        }
        const chainId = await chainOf(origin);
        if (tx.chainId !== undefined && Number.parseInt(tx.chainId as string, 16) !== chainId) {
          fail(ERR.invalid, 'This transaction is for another network.');
        }
        const clean = {
          from: from.evm,
          to: (tx.to as string | undefined) ?? null,
          value: (tx.value as string | undefined) ?? '0x0',
          data: ((tx.data ?? tx.input) as string | undefined) ?? '0x',
          gas: tx.gas as string | undefined,
        };
        return resultOf(await askFor('evmSend', origin, icon, from, { tx: clean, chainId }));
      }
      case 'eth_sign':
        // Signs any hash, including a transaction's: phishing's favourite. Never.
        return fail(ERR.unsupported, 'Honey never signs raw hashes (eth_sign).');
      default: {
        if (!READ_ONLY.has(method)) return fail(ERR.unsupported);
        const network = evmNetwork(await chainOf(origin)) ?? EVM_NETWORKS[0];
        return deps.rpc(network?.rpc ?? '', method, args);
      }
    }
  }

  // Solana (Wallet Standard)

  async function solana(origin: string, icon: string | undefined, method: string, params: unknown) {
    const input = (params ?? {}) as Record<string, unknown>;
    const site = await siteOf(origin);
    const connected = site?.solana ? site : undefined;
    const authorized = () => {
      if (!connected?.solana) return fail(ERR.unauthorized);
      if (input.account !== connected.solana) {
        fail(ERR.unauthorized, 'That account isn’t connected to this site.');
      }
      return connected;
    };
    const base64 = (value: unknown) =>
      typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length > 0
        ? value
        : fail(ERR.invalid);

    switch (method) {
      case 'connect': {
        if (connected?.solana) return { address: connected.solana };
        if (input.silent) return { address: null };
        return { address: (await connect(origin, icon, 'solana')).solana };
      }
      case 'disconnect':
        await disconnect(origin);
        return null;
      case 'signMessage': {
        const from = authorized();
        const message = base64(input.message);
        return resultOf(await askFor('solanaSignMessage', origin, icon, from, { message }));
      }
      case 'signTransaction':
      case 'signAndSendTransaction': {
        const from = authorized();
        const transaction = base64(input.transaction);
        const kind = method === 'signTransaction' ? 'solanaSignTransaction' : 'solanaSend';
        return resultOf(await askFor(kind, origin, icon, from, { transaction }));
      }
      default:
        return fail(ERR.unsupported);
    }
  }

  return {
    /** A website's call; resolves with its result or rejects with a ProviderError. */
    async fromPage(origin: string, icon: string | undefined, request: PageRequest) {
      if (typeof request.method !== 'string') return fail(ERR.invalid);
      return request.namespace === 'solana'
        ? solana(origin, icon, request.method, request.params)
        : evm(origin, icon, request.method, request.params);
    },

    /** The oldest request still waiting, for the approval window. */
    next(): Approval | null {
      let oldest: Approval | null = null;
      for (const { approval } of pending.values()) {
        if (!oldest || approval.createdAt < oldest.createdAt) oldest = approval;
      }
      return oldest;
    },

    answer(answer: Answer) {
      const entry = pending.get(answer.id);
      if (!entry) return false;
      pending.delete(answer.id);
      refreshBadge();
      entry.settle(answer);
      return true;
    },

    /** The approval window closed: anything still waiting is a "no". */
    rejectAll() {
      for (const id of [...pending.keys()]) this.answer({ id, error: ERR.rejected });
    },

    sites: async () => Object.values(await sites()),
    disconnect,

    /** Sign out or reset: no site stays connected to wallets that are gone. */
    async forgetAll() {
      for (const origin of Object.keys(await sites())) await disconnect(origin);
      await deps.save(STORAGE.chains, {});
    },

    setWaiting(count: number) {
      waiting = Math.max(0, Math.floor(count) || 0);
      refreshBadge();
    },
  };
}

export type Router = ReturnType<typeof createRouter>;
