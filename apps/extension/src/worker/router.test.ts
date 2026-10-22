import { describe, expect, it } from 'vitest';
import {
  type Approval,
  ERR,
  type PageReply,
  type Site,
  STORAGE,
  siteMatchesWallet,
} from './protocol';
import { createRouter } from './router';

const SITE = 'https://app.example';
const EVM = '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826';
const OTHER = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
const SOL = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';

function setup(
  options: {
    canUseSite?: (site: Site) => Promise<boolean>;
    rpc?: (url: string, method: string, params: unknown) => Promise<unknown>;
  } = {},
) {
  const store = new Map<string, unknown>();
  const events: { origin: string; reply: PageReply }[] = [];
  const rpcCalls: { url: string; method: string; params: unknown }[] = [];
  const badges: number[] = [];
  let opened = 0;
  let id = 0;
  const router = createRouter({
    canUseSite: options.canUseSite ?? (async () => true),
    load: async <T>(key: string) => store.get(key) as T | undefined,
    save: async (key, value) => {
      store.set(key, structuredClone(value));
    },
    openApprovals: async () => {
      opened++;
    },
    rpc: async (url, method, params) => {
      rpcCalls.push({ url, method, params });
      return options.rpc ? options.rpc(url, method, params) : '0x10';
    },
    emit: (origin, reply) => events.push({ origin, reply }),
    badge: (count) => badges.push(count),
    newId: () => `a${++id}`,
    now: () => id,
  });
  const call = (method: string, params?: unknown, namespace: 'evm' | 'solana' = 'evm') =>
    router.fromPage(SITE, undefined, { id: 1, namespace, method, params });
  /** Waits for the next approval to show up in the window. */
  const nextApproval = async () => {
    for (let i = 0; i < 20; i++) {
      const next = router.next();
      if (next) return next as Approval;
      await Promise.resolve();
    }
    throw new Error('no approval');
  };
  const connect = async (picked = { evm: EVM, solana: SOL }) => {
    const accounts = call('eth_requestAccounts');
    const approval = await nextApproval();
    router.answer({
      id: approval.id,
      connect: { walletId: 'w1', walletName: 'Main', ...picked },
    });
    return accounts;
  };
  return {
    store,
    router,
    call,
    nextApproval,
    connect,
    events,
    rpcCalls,
    badges,
    opened: () => opened,
  };
}

describe('connecting', () => {
  it('starts on Ethereum with no accounts', async () => {
    const { call } = setup();
    expect(await call('eth_chainId')).toBe('0x1');
    expect(await call('net_version')).toBe('1');
    expect(await call('eth_accounts')).toEqual([]);
  });

  it('asks before connecting, then remembers the site', async () => {
    const t = setup();
    expect(await t.connect()).toEqual([EVM]);
    expect(t.opened()).toBe(1);
    expect(await t.call('eth_accounts')).toEqual([EVM]);
    expect(await t.call('eth_requestAccounts')).toEqual([EVM]);
    expect(t.events.map((e) => e.reply)).toContainEqual({
      event: 'accountsChanged',
      namespace: 'evm',
      data: [EVM],
    });
    expect((await t.router.sites())[0]).toMatchObject({ origin: SITE, walletName: 'Main' });
  });

  it('answers a second connect while one is waiting with -32002', async () => {
    const t = setup();
    void t.call('eth_requestAccounts');
    await t.nextApproval();
    await expect(t.call('eth_requestAccounts')).rejects.toEqual(ERR.pending);
  });

  it('rejects with 4001 when the window closes', async () => {
    const t = setup();
    const accounts = t.call('eth_requestAccounts');
    await t.nextApproval();
    t.router.rejectAll();
    await expect(accounts).rejects.toEqual(ERR.rejected);
    expect(t.router.next()).toBeNull();
  });

  it('won’t connect EVM to a wallet without an EVM address', async () => {
    const t = setup();
    await expect(t.connect({ evm: null as never, solana: SOL })).rejects.toEqual(ERR.unauthorized);
  });

  it('disconnects and tells the page', async () => {
    const t = setup();
    await t.connect();
    await t.router.disconnect(SITE);
    expect(await t.call('eth_accounts')).toEqual([]);
    expect(t.events.at(-2)?.reply).toEqual({
      event: 'accountsChanged',
      namespace: 'evm',
      data: [],
    });
  });

  it('revokes an unclaimed approval when its origin disconnects', async () => {
    const t = setup();
    await t.connect();
    const signing = t.call('personal_sign', ['0x6869', EVM]);
    const approval = await t.nextApproval();

    const disconnecting = t.router.disconnect(SITE);
    // disconnect revokes synchronously before its first storage await, so a stale
    // approval view cannot claim while disconnect persistence is still in flight.
    expect(t.router.claim(approval.id)).toBe(false);
    await disconnecting;

    await expect(signing).rejects.toEqual(ERR.rejected);
    expect(t.router.next()).toBeNull();
    expect(t.router.claim(approval.id)).toBe(false);
  });

  it('lets a claimed approval finish if disconnect races after owner confirmation', async () => {
    const t = setup();
    await t.connect();
    const signing = t.call('personal_sign', ['0x6869', EVM]);
    const approval = await t.nextApproval();

    // Claim is the atomic boundary after owner confirmation and before signing.
    expect(t.router.claim(approval.id)).toBe(true);
    // A resumed approval UI re-authenticates before repeating this idempotent claim.
    expect(t.router.claim(approval.id)).toBe(true);
    await t.router.disconnect(SITE);
    expect(t.router.next()?.id).toBe(approval.id);
    t.router.answer({ id: approval.id, result: '0xsig' });
    await expect(signing).resolves.toBe('0xsig');
  });
});

describe('signing', () => {
  it('needs a connection and the connected address', async () => {
    const t = setup();
    await expect(t.call('personal_sign', ['0x68656c6c6f', EVM])).rejects.toEqual(ERR.unauthorized);
    await t.connect();
    await expect(t.call('personal_sign', ['0x68656c6c6f', OTHER])).rejects.toMatchObject({
      code: 4100,
    });
  });

  it('passes the message to the window and the signature back, either param order', async () => {
    const t = setup();
    await t.connect();
    for (const params of [
      ['0x68656c6c6f', EVM],
      [EVM, '0x68656c6c6f'],
    ]) {
      const signed = t.call('personal_sign', params);
      const approval = await t.nextApproval();
      expect(approval).toMatchObject({ kind: 'evmSign', params: { message: '0x68656c6c6f' } });
      expect(approval.site?.evm).toBe(EVM);
      t.router.answer({ id: approval.id, result: '0xsig' });
      expect(await signed).toBe('0xsig');
    }
  });

  it('never signs eth_sign', async () => {
    const t = setup();
    await t.connect();
    await expect(t.call('eth_sign', [EVM, `0x${'00'.repeat(32)}`])).rejects.toMatchObject({
      code: 4200,
    });
  });

  it('takes typed data as a string or an object', async () => {
    const t = setup();
    await t.connect();
    const signed = t.call('eth_signTypedData_v4', [EVM, { primaryType: 'Mail' }]);
    const approval = await t.nextApproval();
    expect(approval.params).toEqual({ data: '{"primaryType":"Mail"}' });
    t.router.answer({ id: approval.id, error: ERR.rejected });
    await expect(signed).rejects.toEqual(ERR.rejected);
  });

  it('checks a transaction’s sender, fields and network', async () => {
    const t = setup();
    await t.connect();
    await expect(t.call('eth_sendTransaction', [{ from: OTHER, to: OTHER }])).rejects.toMatchObject(
      { code: 4100 },
    );
    await expect(t.call('eth_sendTransaction', [{ from: EVM, to: 'nope' }])).rejects.toMatchObject({
      code: -32602,
    });
    await expect(
      t.call('eth_sendTransaction', [{ from: EVM, to: OTHER, chainId: '0x2105' }]),
    ).rejects.toMatchObject({ message: 'This transaction is for another network.' });
    const sent = t.call('eth_sendTransaction', [
      { from: EVM, to: OTHER, value: '0x1', input: '0xab' },
    ]);
    const approval = await t.nextApproval();
    expect(approval.params).toEqual({
      chainId: 1,
      tx: { from: EVM, to: OTHER, value: '0x1', data: '0xab', gas: undefined },
    });
    t.router.answer({ id: approval.id, result: '0xhash' });
    expect(await sent).toBe('0xhash');
  });

  it('limits how many requests one site can leave waiting', async () => {
    const t = setup();
    await t.connect();
    for (let i = 0; i < 5; i++) void t.call('personal_sign', ['0x00', EVM]).catch(() => {});
    await t.nextApproval();
    await expect(t.call('personal_sign', ['0x00', EVM])).rejects.toEqual(ERR.busy);
  });
});

describe('networks', () => {
  it('asks to switch to a network Honey knows, and refuses others with 4902', async () => {
    const t = setup();
    await expect(t.call('wallet_switchEthereumChain', [{ chainId: '0x999999' }])).rejects.toEqual(
      ERR.unknownChain,
    );
    const switched = t.call('wallet_switchEthereumChain', [{ chainId: '0x2105' }]);
    const approval = await t.nextApproval();
    expect(approval).toMatchObject({ kind: 'switchChain', params: 8453 });
    t.router.answer({ id: approval.id, result: null });
    expect(await switched).toBeNull();
    expect(await t.call('eth_chainId')).toBe('0x2105');
    expect(t.events.at(-1)?.reply).toEqual({
      event: 'chainChanged',
      namespace: 'evm',
      data: '0x2105',
    });
    // Already there: nothing to ask.
    expect(await t.call('wallet_switchEthereumChain', [{ chainId: '0x2105' }])).toBeNull();
  });

  it('keeps the network after connecting', async () => {
    const t = setup();
    const switched = t.call('wallet_switchEthereumChain', [{ chainId: '0x2105' }]);
    t.router.answer({ id: (await t.nextApproval()).id, result: null });
    await switched;
    await t.connect();
    expect((await t.router.sites())[0]?.chainId).toBe(8453);
  });

  it('stays on its network after disconnecting and connecting again', async () => {
    const t = setup();
    await t.connect();
    const switched = t.call('wallet_switchEthereumChain', [{ chainId: '0x2105' }]);
    t.router.answer({ id: (await t.nextApproval()).id, result: null });
    await switched;
    await t.router.disconnect(SITE);
    expect(await t.call('eth_chainId')).toBe('0x2105');
  });

  it('sends reads to the network’s public node and refuses unknown methods', async () => {
    const t = setup();
    expect(await t.call('eth_blockNumber', [])).toBe('0x10');
    expect(t.rpcCalls[0]).toEqual({
      url: 'https://ethereum-rpc.publicnode.com',
      method: 'eth_blockNumber',
      params: [],
    });
    await expect(t.call('debug_traceTransaction', [])).rejects.toEqual(ERR.unsupported);
  });

  it('bounds log ranges and rejects unbounded log scans before calling the node', async () => {
    const t = setup();
    await expect(t.call('eth_getLogs', [{ fromBlock: '0x0', toBlock: 'latest' }])).rejects.toEqual({
      ...ERR.invalid,
      message: 'Read request is too large or expensive.',
    });
    await expect(
      t.call('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x7d1' }]),
    ).rejects.toMatchObject({ code: -32602 });
    expect(await t.call('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x7d0' }])).toBe('0x10');
    expect(t.rpcCalls).toHaveLength(1);
  });

  it('caps read payload size and per-origin read rate', async () => {
    const t = setup();
    await expect(
      t.call('eth_call', [{ data: `0x${'ab'.repeat(70_000)}` }, 'latest']),
    ).rejects.toMatchObject({
      code: -32602,
    });
    for (let i = 0; i < 20; i++) await t.call('eth_blockNumber');
    await expect(t.call('eth_blockNumber')).rejects.toEqual({
      ...ERR.busy,
      message: 'Too many network reads. Try again shortly.',
    });
    expect(t.rpcCalls).toHaveLength(20);
  });

  it('rejects excess in-flight reads instead of queuing unbounded work', async () => {
    const releases: ((value: unknown) => void)[] = [];
    const t = setup({ rpc: () => new Promise((resolve) => releases.push(resolve)) });
    const active = Array.from({ length: 4 }, () => t.call('eth_blockNumber'));
    for (let i = 0; i < 20 && releases.length < 4; i++) await Promise.resolve();
    expect(releases).toHaveLength(4);
    await expect(t.call('eth_blockNumber')).rejects.toMatchObject({ code: -32005 });
    for (const release of releases) release('0x10');
    await Promise.all(active);
  });

  it('applies a global rate limit across distinct origins', async () => {
    const t = setup();
    for (let origin = 0; origin < 6; origin++) {
      for (let request = 0; request < 20; request++) {
        await t.router.fromPage(`https://site-${origin}.example`, undefined, {
          id: request,
          namespace: 'evm',
          method: 'eth_blockNumber',
        });
      }
    }
    await expect(
      t.router.fromPage('https://seventh.example', undefined, {
        id: 1,
        namespace: 'evm',
        method: 'eth_blockNumber',
      }),
    ).rejects.toMatchObject({ code: -32005 });
    expect(t.rpcCalls).toHaveLength(120);
  });

  it('bounds all page calls before storage or provider work', async () => {
    const t = setup();
    for (let request = 0; request < 120; request++) await t.call('eth_chainId');
    await expect(t.call('eth_chainId')).rejects.toMatchObject({ code: -32005 });
  });

  it('caps global in-flight reads across distinct origins', async () => {
    const releases: ((value: unknown) => void)[] = [];
    const t = setup({ rpc: () => new Promise((resolve) => releases.push(resolve)) });
    const active = Array.from({ length: 24 }, (_, index) =>
      t.router.fromPage(`https://site-${Math.floor(index / 4)}.example`, undefined, {
        id: index,
        namespace: 'evm',
        method: 'eth_blockNumber',
      }),
    );
    for (let i = 0; i < 30 && releases.length < 24; i++) await Promise.resolve();
    expect(releases).toHaveLength(24);
    await expect(
      t.router.fromPage('https://overflow.example', undefined, {
        id: 25,
        namespace: 'evm',
        method: 'eth_blockNumber',
      }),
    ).rejects.toMatchObject({ code: -32005 });
    for (const release of releases) release('0x10');
    await Promise.all(active);
  });
});

describe('Solana', () => {
  it('connects silently only when already connected', async () => {
    const t = setup();
    expect(await t.call('connect', { silent: true }, 'solana')).toEqual({ address: null });
    await t.connect();
    expect(await t.call('connect', { silent: true }, 'solana')).toEqual({ address: SOL });
  });

  it('signs only for the connected account', async () => {
    const t = setup();
    await t.connect();
    await expect(
      t.call('signMessage', { account: 'someone', message: 'aGk=' }, 'solana'),
    ).rejects.toMatchObject({ code: 4100 });
    await expect(t.call('signMessage', { account: SOL, message: '%%' }, 'solana')).rejects.toEqual(
      ERR.invalid,
    );
    // A transaction's bytes (0x80 = a v0 message) aren't text: refused before any window opens.
    await expect(
      t.call('signMessage', { account: SOL, message: btoa('\x80\x01\x00\x01') }, 'solana'),
    ).rejects.toMatchObject({ code: 4200 });
    const sent = t.call('signAndSendTransaction', { account: SOL, transaction: 'AQID' }, 'solana');
    const approval = await t.nextApproval();
    expect(approval).toMatchObject({ kind: 'solanaSend', params: { transaction: 'AQID' } });
    t.router.answer({ id: approval.id, result: { signature: 'sig' } });
    expect(await sent).toEqual({ signature: 'sig' });
  });
});

describe('badge', () => {
  it('counts waiting requests and shared-wallet proposals', async () => {
    const t = setup();
    t.router.setWaiting(2);
    void t.call('eth_requestAccounts').catch(() => {});
    await t.nextApproval();
    expect(t.badges.at(-1)).toBe(3);
    t.router.rejectAll();
    expect(t.badges.at(-1)).toBe(2);
  });

  it('forgets every site on sign out', async () => {
    const t = setup();
    await t.connect();
    await t.router.forgetAll();
    expect(await t.router.sites()).toEqual([]);
  });
});

it('filters cached legacy shared, missing-key and mismatched accounts while retaining real permissions', async () => {
  const wallet = { id: 'real', kind: 'wallet', addresses: { evm: EVM, solana: SOL } };
  const t = setup({ canUseSite: async (site) => siteMatchesWallet(site, wallet) });
  const permission = {
    origin: SITE,
    walletId: 'legacy',
    walletName: 'Old shared',
    evm: OTHER,
    solana: null,
    chainId: 1,
    connectedAt: 1,
  };
  t.store.set(STORAGE.sites, { [SITE]: permission });
  expect(await t.call('eth_accounts')).toEqual([]);
  expect(await t.router.sites()).toEqual([]);
  expect(
    siteMatchesWallet(
      { ...permission, walletId: 'real', evm: EVM },
      { ...wallet, kind: 'multisig' },
    ),
  ).toBe(false);
  expect(
    siteMatchesWallet(
      { ...permission, walletId: 'real', evm: EVM },
      { ...wallet, watchOnly: true },
    ),
  ).toBe(false);
  t.store.set(STORAGE.sites, { [SITE]: { ...permission, walletId: 'real' } });
  expect(await t.call('eth_accounts')).toEqual([]);
  t.store.set(STORAGE.sites, {
    [SITE]: { ...permission, walletId: 'real', evm: EVM.toLowerCase(), solana: SOL },
  });
  expect(await t.call('eth_accounts')).toEqual([EVM.toLowerCase()]);
  expect(
    siteMatchesWallet({ ...permission, walletId: 'real', evm: null, solana: SOL }, wallet),
  ).toBe(true);
});

it('does not install a new permission for an unbacked address', async () => {
  const t = setup({ canUseSite: async () => false });
  await expect(t.connect()).rejects.toMatchObject(ERR.unauthorized);
  expect(await t.call('eth_accounts')).toEqual([]);
});
