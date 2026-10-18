import { describe, expect, it } from 'vitest';
import { type Approval, ERR, type PageReply } from './protocol';
import { createRouter } from './router';

const SITE = 'https://app.example';
const EVM = '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826';
const OTHER = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB';
const SOL = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';

function setup() {
  const store = new Map<string, unknown>();
  const events: { origin: string; reply: PageReply }[] = [];
  const rpcCalls: { url: string; method: string; params: unknown }[] = [];
  const badges: number[] = [];
  let opened = 0;
  let id = 0;
  const router = createRouter({
    load: async <T>(key: string) => store.get(key) as T | undefined,
    save: async (key, value) => {
      store.set(key, structuredClone(value));
    },
    openApprovals: async () => {
      opened++;
    },
    rpc: async (url, method, params) => {
      rpcCalls.push({ url, method, params });
      return '0x10';
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
  return { router, call, nextApproval, connect, events, rpcCalls, badges, opened: () => opened };
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
