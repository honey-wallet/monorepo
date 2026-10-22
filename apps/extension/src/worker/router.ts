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
  canUseSite: (site: Site) => Promise<boolean>;
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
const RPC_WINDOW_MS = 10_000;
const MAX_RPC_PER_SITE_WINDOW = 20;
const MAX_RPC_GLOBAL_WINDOW = 120;
const MAX_RPC_PER_SITE_IN_FLIGHT = 4;
const MAX_RPC_GLOBAL_IN_FLIGHT = 24;
const MAX_RPC_REQUEST_BYTES = 128 * 1024;
const MAX_LOG_BLOCK_RANGE = 2_000;
const PAGE_WINDOW_MS = 10_000;
const MAX_PAGE_PER_SITE_WINDOW = 120;
const MAX_PAGE_GLOBAL_WINDOW = 600;
const MAX_PAGE_PER_SITE_IN_FLIGHT = 16;
const MAX_PAGE_GLOBAL_IN_FLIGHT = 64;

type RpcBudget = { requests: number[]; inFlight: number };
type PageBudget = { requests: number[]; inFlight: number };

function validateReadRequest(method: string, params: unknown) {
  let serialized: string;
  try {
    serialized = JSON.stringify(params ?? []);
  } catch {
    return false;
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_RPC_REQUEST_BYTES) return false;
  if (method === 'eth_getLogs') {
    const filter = (Array.isArray(params) ? params[0] : undefined) as
      | { fromBlock?: unknown; toBlock?: unknown }
      | undefined;
    const from = filter?.fromBlock;
    const to = filter?.toBlock;
    // Numeric ranges are bounded. Tags such as latest/safe/finalized and blockHash
    // filters are single-block queries and remain usable.
    if (filter && typeof filter === 'object' && 'blockHash' in filter) return true;
    if (
      typeof from === 'string' &&
      /^0x[0-9a-f]+$/i.test(from) &&
      typeof to === 'string' &&
      /^0x[0-9a-f]+$/i.test(to)
    ) {
      const first = BigInt(from);
      const last = BigInt(to);
      if (last < first || last - first + 1n > BigInt(MAX_LOG_BLOCK_RANGE)) return false;
    } else if (
      typeof from !== 'string' ||
      typeof to !== 'string' ||
      from !== to ||
      !['latest', 'safe', 'finalized', 'pending', 'earliest'].includes(from)
    ) {
      return false;
    }
  }
  return true;
}

const fail = (error: ProviderError, message?: string): never => {
  throw message ? { ...error, message } : error;
};

const isAddress = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const isHex = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value);
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const toHex = (n: number) => `0x${n.toString(16)}`;

/** Base64 that decodes to UTF-8 text with no control characters (newlines and tabs allowed). */
export function isReadableText(data: string) {
  try {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: that's the check
    return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text);
  } catch {
    return false;
  }
}

type Pending = { approval: Approval; settle: (answer: Answer) => void; claimed: boolean };

/** Who's asking: the tab's icon, and for WalletConnect, its check of the site's domain. */
export type Caller = { icon?: string; verified?: Approval['verified'] };

export function createRouter(deps: RouterDeps) {
  const pending = new Map<string, Pending>();
  const rpcByOrigin = new Map<string, RpcBudget>();
  const globalRpcRequests: number[] = [];
  let globalRpcInFlight = 0;
  const pageByOrigin = new Map<string, PageBudget>();
  const globalPageRequests: number[] = [];
  let globalPageInFlight = 0;
  let waiting = 0;

  function admitPageRequest(origin: string) {
    const now = deps.now();
    const prune = (requests: number[]) => {
      while (requests.length) {
        const first = requests[0];
        if (first === undefined || now - first < PAGE_WINDOW_MS) break;
        requests.shift();
      }
    };
    prune(globalPageRequests);
    for (const [key, value] of pageByOrigin) {
      prune(value.requests);
      if (!value.inFlight && !value.requests.length) pageByOrigin.delete(key);
    }
    let budget = pageByOrigin.get(origin);
    if (!budget) {
      budget = { requests: [], inFlight: 0 };
      pageByOrigin.set(origin, budget);
    }
    if (
      budget.requests.length >= MAX_PAGE_PER_SITE_WINDOW ||
      globalPageRequests.length >= MAX_PAGE_GLOBAL_WINDOW ||
      budget.inFlight >= MAX_PAGE_PER_SITE_IN_FLIGHT ||
      globalPageInFlight >= MAX_PAGE_GLOBAL_IN_FLIGHT
    )
      return fail(ERR.busy, 'Too many wallet requests. Try again shortly.');
    budget.requests.push(now);
    globalPageRequests.push(now);
    budget.inFlight++;
    globalPageInFlight++;
    return () => {
      budget.inFlight--;
      globalPageInFlight--;
    };
  }

  async function boundedRpc(origin: string, url: string, method: string, params: unknown) {
    if (!validateReadRequest(method, params))
      return fail(ERR.invalid, 'Read request is too large or expensive.');
    const now = deps.now();
    const prune = (requests: number[]) => {
      while (requests.length) {
        const first = requests[0];
        if (first === undefined || now - first < RPC_WINDOW_MS) break;
        requests.shift();
      }
    };
    prune(globalRpcRequests);
    for (const [key, value] of rpcByOrigin) {
      prune(value.requests);
      if (!value.inFlight && !value.requests.length) rpcByOrigin.delete(key);
    }
    let budget = rpcByOrigin.get(origin);
    if (!budget) {
      budget = { requests: [], inFlight: 0 };
      rpcByOrigin.set(origin, budget);
    }
    prune(budget.requests);
    if (
      budget.requests.length >= MAX_RPC_PER_SITE_WINDOW ||
      globalRpcRequests.length >= MAX_RPC_GLOBAL_WINDOW ||
      budget.inFlight >= MAX_RPC_PER_SITE_IN_FLIGHT ||
      globalRpcInFlight >= MAX_RPC_GLOBAL_IN_FLIGHT
    )
      return fail(ERR.busy, 'Too many network reads. Try again shortly.');
    budget.requests.push(now);
    globalRpcRequests.push(now);
    budget.inFlight++;
    globalRpcInFlight++;
    try {
      return await deps.rpc(url, method, params);
    } finally {
      budget.inFlight--;
      globalRpcInFlight--;
      if (!budget.inFlight && !budget.requests.length) rpcByOrigin.delete(origin);
    }
  }

  const refreshBadge = () => deps.badge(pending.size + waiting);

  // Sites

  const sites = async () => {
    const saved = (await deps.load<Record<string, Site>>(STORAGE.sites)) ?? {};
    const valid: Record<string, Site> = {};
    for (const [origin, site] of Object.entries(saved)) {
      if (await deps.canUseSite(site)) valid[origin] = site;
    }
    return valid;
  };
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
    // Pending requests have not been approved yet, so disconnect makes their old
    // approval screens stale. Claimed requests crossed the explicit UI confirmation
    // boundary and are allowed to finish. Revoke before the first await: claim() and
    // this loop run synchronously in the worker, so exactly one side wins that race.
    for (const [id, entry] of pending) {
      if (entry.approval.origin === origin && !entry.claimed) {
        pending.delete(id);
        entry.settle({ id, error: ERR.rejected });
      }
    }
    refreshBadge();

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
    caller: Caller,
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
      icon: caller.icon,
      verified: caller.verified,
      site,
      params,
      createdAt: deps.now(),
    };
    return new Promise<Answer>((settle) => {
      pending.set(approval.id, { approval, settle, claimed: false });
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

  async function connect(origin: string, caller: Caller, namespace: 'evm' | 'solana') {
    const answer = await askFor('connect', origin, caller, undefined, { namespace });
    if (!('connect' in answer)) return fail(ERR.internal);
    const picked = answer.connect;
    if (!(namespace === 'evm' ? picked.evm : picked.solana)) fail(ERR.unauthorized);
    const site: Site = {
      origin,
      ...picked,
      chainId: await chainOf(origin),
      connectedAt: deps.now(),
    };
    if (!(await deps.canUseSite(site))) return fail(ERR.unauthorized);
    await saveSite(origin, site);
    announce(origin, site);
    return site;
  }

  const resultOf = (answer: Answer) => ('result' in answer ? answer.result : fail(ERR.internal));

  // EVM (EIP-1193)

  async function evm(origin: string, caller: Caller, method: string, params: unknown) {
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
        const added = await connect(origin, caller, 'evm');
        return [added.evm];
      }
      case 'wallet_requestPermissions': {
        if (!connected?.evm) await connect(origin, caller, 'evm');
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
        await askFor('switchChain', origin, caller, site, chainId);
        await setChain(origin, chainId);
        return null;
      }
      case 'personal_sign': {
        // [message, address]; some sites send them the other way round.
        let [message, address] = args as unknown[];
        if (isAddress(message) && !isAddress(address)) [message, address] = [address, message];
        if (typeof message !== 'string') return fail(ERR.invalid);
        const from = authorized(address);
        return resultOf(await askFor('evmSign', origin, caller, from, { message }));
      }
      case 'eth_signTypedData_v4':
      case 'eth_signTypedData_v3': {
        const [address, data] = args as unknown[];
        const from = authorized(address);
        const json = typeof data === 'string' ? data : JSON.stringify(data);
        if (!json) return fail(ERR.invalid);
        return resultOf(await askFor('evmTypedData', origin, caller, from, { data: json }));
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
        return resultOf(await askFor('evmSend', origin, caller, from, { tx: clean, chainId }));
      }
      case 'eth_sign':
        // Signs any hash, including a transaction's: phishing's favourite. Never.
        return fail(ERR.unsupported, 'Honey never signs raw hashes (eth_sign).');
      default: {
        if (!READ_ONLY.has(method)) return fail(ERR.unsupported);
        const network = evmNetwork(await chainOf(origin)) ?? EVM_NETWORKS[0];
        return boundedRpc(origin, network?.rpc ?? '', method, args);
      }
    }
  }

  // Solana (Wallet Standard)

  async function solana(origin: string, caller: Caller, method: string, params: unknown) {
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
        return { address: (await connect(origin, caller, 'solana')).solana };
      }
      case 'disconnect':
        await disconnect(origin);
        return null;
      case 'signMessage': {
        const from = authorized();
        const message = base64(input.message);
        // Raw bytes could be a transaction's message in disguise: sign readable text only.
        if (!isReadableText(message)) {
          fail(ERR.unsupported, 'Honey only signs readable text messages on Solana.');
        }
        return resultOf(await askFor('solanaSignMessage', origin, caller, from, { message }));
      }
      case 'signTransaction':
      case 'signAndSendTransaction': {
        const from = authorized();
        const transaction = base64(input.transaction);
        const kind = method === 'signTransaction' ? 'solanaSignTransaction' : 'solanaSend';
        return resultOf(await askFor(kind, origin, caller, from, { transaction }));
      }
      default:
        return fail(ERR.unsupported);
    }
  }

  return {
    /** A website's call; resolves with its result or rejects with a ProviderError. */
    async fromPage(origin: string, from: string | undefined | Caller, request: PageRequest) {
      if (typeof request.method !== 'string' || request.method.length > 128)
        return fail(ERR.invalid);
      const release = admitPageRequest(origin);
      const caller: Caller = typeof from === 'object' ? from : { icon: from };
      try {
        return await (request.namespace === 'solana'
          ? solana(origin, caller, request.method, request.params)
          : evm(origin, caller, request.method, request.params));
      } finally {
        release();
      }
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

    /**
     * Atomically crosses the approval boundary for a still-pending request. The UI
     * must call this only after the owner confirms and before signing or any side effect.
     * A successful claim is treated as user-approved; a later disconnect won't revoke it.
     */
    claim(id: string) {
      const entry = pending.get(id);
      if (!entry) return false;
      entry.claimed = true;
      return true;
    },

    /** The approval window closed: anything still waiting is a "no". */
    rejectAll() {
      for (const id of [...pending.keys()]) this.answer({ id, error: ERR.rejected });
    },

    sites: async () => Object.values(await sites()),

    /**
     * WalletConnect: the site names the chain on every request, among those the session
     * already allows, so it's set without asking (a browser site asks to switch instead).
     */
    async pinChain(origin: string, chainId: number) {
      if (!evmNetwork(chainId)) return fail(ERR.unknownChain);
      if ((await chainOf(origin)) !== chainId) await setChain(origin, chainId);
    },
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
