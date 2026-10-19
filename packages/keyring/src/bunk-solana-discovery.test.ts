import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base58, base64 } from '@scure/base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUNK_MAX_INDEX } from './bunk';
import { BUNK_SOLANA_SYSTEM, bunkSolanaAddressBytes } from './bunk-solana';
import {
  BUNK_SOLANA_TOKEN_ACCOUNT_LIMIT,
  BUNK_SOLANA_TOKEN_PROGRAMS,
  discoverBunkSolanaAccounts,
} from './bunk-solana-discovery';
import type { BunkSolanaAccess, BunkSolanaRelease } from './bunk-solana-observe';
import fixture from './fixtures/bunk-solana.json';
import { mnemonicToSeed } from './index';

const first = fixture.cases[0];
if (!first) throw new Error('Missing fixture');
const f = first;
const code = Uint8Array.of(1, 2, 3, 4);
const release: BunkSolanaRelease = {
  genesisHash: f.scope.genesisHash,
  program: f.scope.program,
  programData: base58.encode(new Uint8Array(32).fill(12)),
  codeSha256: `0x${bytesToHex(sha256(code))}`,
  codeLength: code.length,
  upgradeAuthority: null,
};
let seed: Uint8Array;
beforeAll(async () => {
  seed = await mnemonicToSeed(fixture.phrase);
});
afterAll(() => seed.fill(0));
function raw(owner: string, data: Uint8Array, executable = false, lamports = 20_000_000) {
  return { owner, data: [base64.encode(data), 'base64'], executable, lamports };
}
const mintKey = (program: string, id = 0) =>
  base58.encode(sha256(utf8ToBytes(`mint:${program}:${id}`)));
function mintRow(program: string, decimals = 6) {
  const space = program === BUNK_SOLANA_TOKEN_PROGRAMS[0] ? 82 : 170;
  const data = new Uint8Array(Math.min(space, 166)),
    view = new DataView(data.buffer);
  view.setBigUint64(36, 0xffffffffffffffffn, true);
  data[44] = decimals;
  data[45] = 1;
  if (space > 82) data[165] = 1;
  return { ...raw(program, data), space };
}
function tokenRow(wallet: string, program: string, id = 1, space = 165) {
  const data = new Uint8Array(Math.min(space, 166)),
    view = new DataView(data.buffer);
  data.set(bunkSolanaAddressBytes(mintKey(program)));
  data.set(bunkSolanaAddressBytes(wallet), 32);
  view.setBigUint64(64, id === 1 ? 0n : 0xffffffffffffffffn, true);
  data[108] = space > 165 ? 2 : 1;
  if (space > 165) data[165] = 2;
  return {
    pubkey: base58.encode(sha256(utf8ToBytes(`${wallet}:${program}:${id}`))),
    account: { ...raw(program, data), space },
  };
}
type TokenResponse = { context: { slot: number }; value: ReturnType<typeof tokenRow>[] };
class Chain {
  now = 1200;
  reads = 0;
  blockReads = 0;
  calls = 0;
  tokenReads = 0;
  tokenRequests: (readonly unknown[])[] = [];
  mintRequests: (readonly unknown[])[] = [];
  mintRecords = new Map(
    BUNK_SOLANA_TOKEN_PROGRAMS.map((program) => [mintKey(program), mintRow(program)]),
  );
  data: Uint8Array | null = hexToBytes(f.state);
  prefund = false;
  change: (method: string, result: unknown, params: readonly unknown[]) => unknown = (_, result) =>
    result;
  access: BunkSolanaAccess = {
    now: () => this.now,
    maxFinalizedAgeSeconds: 300,
    rpc: {
      request: async (method, params) => {
        this.calls++;
        let result: unknown;
        if (method === 'getGenesisHash') result = release.genesisHash;
        else if (method === 'getBlock') {
          this.blockReads++;
          result = {
            blockhash: base58.encode(sha256(utf8ToBytes(`slot-${params[0]}`))),
            blockTime: 1100,
          };
        } else if (
          method === 'getMultipleAccounts' &&
          (params[0] as string[])[0] !== release.program
        ) {
          this.mintRequests.push(params);
          result = {
            context: { slot: (params[1] as { minContextSlot: number }).minContextSlot + 1 },
            value: (params[0] as string[]).map((key) =>
              structuredClone(this.mintRecords.get(key) ?? null),
            ),
          };
        } else if (method === 'getMultipleAccounts') {
          this.reads++;
          const program = concatBytes(
            Uint8Array.of(2, 0, 0, 0),
            bunkSolanaAddressBytes(release.programData),
          );
          const data = new Uint8Array(45 + code.length);
          data[0] = 3;
          data[4] = 1;
          data.set(code, 45);
          const wallet = (params[0] as string[])[2];
          const loader = 'BPFLoaderUpgradeab1e11111111111111111111111';
          result = {
            context: { slot: 100 },
            value: [
              raw(loader, program, true),
              raw(loader, data),
              wallet === f.wallet && this.data
                ? raw(release.program, this.data)
                : this.prefund
                  ? raw(BUNK_SOLANA_SYSTEM, new Uint8Array(), false, 123)
                  : null,
            ],
          };
        } else if (method === 'getTokenAccountsByOwner') {
          this.tokenReads++;
          this.tokenRequests.push(params);
          const wallet = params[0] as string,
            program = (params[1] as { programId: string }).programId;
          const legacy = program === BUNK_SOLANA_TOKEN_PROGRAMS[0];
          result = {
            context: {
              slot: Math.max(
                legacy ? 101 : 103,
                (params[2] as { minContextSlot: number }).minContextSlot,
              ),
            },
            value: legacy
              ? [tokenRow(wallet, program), tokenRow(wallet, program, 2)]
              : [tokenRow(wallet, program, 3, 170)],
          };
        } else throw new Error(`Unexpected RPC ${method}`);
        return this.change(method, result, params);
      },
    },
  };
}
const request = () => ({ release: { ...release }, startAccountIndex: 7, count: 3 });
describe('Solana account discovery', () => {
  it('finds a deployed account and retains empty addresses without authorizing signing', async () => {
    const chain = new Chain();
    const page = await discoverBunkSolanaAccounts(seed, request(), chain.access);
    expect(page.nextAccountIndex).toBe(10);
    expect(page.inventoryComplete).toBe(false);
    expect(page.signingAuthorized).toBe(false);
    expect(page.candidates).toHaveLength(3);
    expect(page.candidates[0]?.wallet).toBe(f.wallet);
    expect(page.candidates[0]?.state?.owner).toBe(f.keys.owner0.commitment);
    expect(page.candidates[0]?.lamports).toBe(20_000_000n);
    expect(page.candidates.slice(1).map((x) => x.state)).toEqual([null, null]);
    expect(page.candidates.every((x) => x.tokenAccounts === null)).toBe(true);
    expect(chain.tokenReads).toBe(0);
    expect(chain.blockReads).toBe(7);
    expect(seed.some(Boolean)).toBe(true);
  });
  it('retains prefunded undeployed addresses and ends pagination at the derivation limit', async () => {
    const chain = new Chain();
    chain.prefund = true;
    const page = await discoverBunkSolanaAccounts(
      seed,
      { ...request(), startAccountIndex: BUNK_MAX_INDEX, count: 1 },
      chain.access,
    );
    expect(page.nextAccountIndex).toBeNull();
    expect(page.candidates[0]?.state).toBeNull();
    expect(page.candidates[0]?.lamports).toBe(123n);
  });
  it('rejects invalid ranges before any RPC', async () => {
    const chain = new Chain();
    for (const [startAccountIndex, count] of [
      [-1, 1],
      [0, 0],
      [0, 21],
      [0, 1.5],
      [BUNK_MAX_INDEX, 2],
    ] as const)
      await expect(
        discoverBunkSolanaAccounts(seed, { ...request(), startAccountIndex, count }, chain.access),
      ).rejects.toThrow('scan range');
    expect(chain.calls).toBe(0);
  });
  it.each([92, 124])('rejects a mismatching phrase authority at offset %i', async (offset) => {
    const chain = new Chain();
    if (!chain.data || chain.data[offset] === undefined) throw new Error('Missing state byte');
    chain.data[offset] ^= 1;
    await expect(discoverBunkSolanaAccounts(seed, request(), chain.access)).rejects.toThrow(
      'authority',
    );
  });
  it('rejects an earlier account anchor changing after later reads', async () => {
    const chain = new Chain();
    chain.change = (method, result) =>
      method === 'getBlock' && chain.blockReads === 7
        ? { ...(result as object), blockhash: f.payer }
        : result;
    await expect(discoverBunkSolanaAccounts(seed, request(), chain.access)).rejects.toThrow(
      'scan anchor',
    );
  });
  it('checks freshness again after the whole scan', async () => {
    const chain = new Chain();
    chain.change = (method, result) => {
      if (method === 'getBlock' && chain.blockReads === 7) chain.now = 1500;
      return result;
    };
    await expect(discoverBunkSolanaAccounts(seed, request(), chain.access)).rejects.toThrow(
      'scan became stale',
    );
  });
  it('rejects a chain switch at the final check', async () => {
    const chain = new Chain();
    chain.change = (method, result) =>
      method === 'getGenesisHash' && chain.blockReads === 7 ? f.payer : result;
    await expect(discoverBunkSolanaAccounts(seed, request(), chain.access)).rejects.toThrow(
      'chain changed',
    );
  });
  it('cancels before starting or while awaiting RPC without returning a partial page', async () => {
    for (const early of [true, false]) {
      const chain = new Chain(),
        controller = new AbortController();
      if (early) controller.abort();
      else
        chain.change = (_, result) => {
          controller.abort();
          return result;
        };
      await expect(
        discoverBunkSolanaAccounts(seed, request(), { ...chain.access, signal: controller.signal }),
      ).rejects.toThrow('cancelled');
      expect(chain.calls).toBe(early ? 0 : 1);
    }
  });
  it('snapshots seed, release and range before awaiting transport', async () => {
    const chain = new Chain(),
      input = request(),
      copy = seed.slice();
    chain.change = (_, result) => {
      copy.fill(0);
      input.count = 100;
      input.release.program = f.payer;
      return result;
    };
    const page = await discoverBunkSolanaAccounts(copy, input, chain.access);
    expect(page.count).toBe(3);
    expect(page.candidates[0]?.wallet).toBe(f.wallet);
  });
  it('propagates transport failure instead of reporting empty accounts', async () => {
    const chain = new Chain();
    chain.change = (method, result) => {
      if (method === 'getMultipleAccounts' && chain.reads === 2) throw new Error('RPC unavailable');
      return result;
    };
    await expect(discoverBunkSolanaAccounts(seed, request(), chain.access)).rejects.toThrow(
      'RPC unavailable',
    );
  });
});

describe('Solana token discovery', () => {
  const input = () => ({ ...request(), count: 1, includeTokenAccounts: true });
  it.each([7, 8])(
    'retains token holdings for account index %i with independent finalized checkpoints',
    async (startAccountIndex) => {
      const chain = new Chain();
      const page = await discoverBunkSolanaAccounts(
        seed,
        { ...input(), startAccountIndex },
        chain.access,
      );
      const candidate = page.candidates[0];
      expect(candidate?.checkpoint.slot).toBe(100);
      expect(candidate?.state === null).toBe(startAccountIndex === 8);
      const snapshots = candidate?.tokenAccounts;
      expect(snapshots?.map((s) => s.checkpoint.slot)).toEqual([101, 103]);
      expect(snapshots?.map((s) => s.tokenProgram)).toEqual(BUNK_SOLANA_TOKEN_PROGRAMS);
      expect(snapshots?.[0]?.accounts.map((a) => a.amount)).toEqual([0n, 0xffffffffffffffffn]);
      expect(snapshots?.[1]?.accounts[0]).toMatchObject({
        mint: mintKey(BUNK_SOLANA_TOKEN_PROGRAMS[1]),
        state: 'frozen',
        extended: true,
        delegate: null,
        closeAuthority: null,
        nativeReserve: null,
      });
      expect(chain.tokenRequests).toEqual(
        BUNK_SOLANA_TOKEN_PROGRAMS.map((programId, i) => [
          candidate?.wallet,
          { programId },
          {
            encoding: 'base64',
            commitment: 'finalized',
            minContextSlot: 100 + i * 2,
            dataSlice: { offset: 0, length: 166 },
          },
        ]),
      );
      expect(page.inventoryComplete).toBe(false);
      expect(page.signingAuthorized).toBe(false);
    },
  );
  it('keeps delegate, close authority and wrapped-native reserve without claiming spendability', async () => {
    const chain = new Chain();
    chain.change = (method, value) => {
      if (method !== 'getTokenAccountsByOwner') return value;
      const r = value as TokenResponse,
        row = r.value[0];
      if (!row?.account.data[0]) throw Error('missing token fixture');
      const data = base64.decode(row.account.data[0]),
        view = new DataView(data.buffer);
      for (const offset of [72, 129]) {
        view.setUint32(offset, 1, true);
        data.set(bunkSolanaAddressBytes(f.payer), offset + 4);
      }
      view.setUint32(109, 1, true);
      view.setBigUint64(113, 2039280n, true);
      view.setBigUint64(121, 4n, true);
      row.account.data[0] = base64.encode(data);
      return r;
    };
    const page = await discoverBunkSolanaAccounts(seed, input(), chain.access);
    expect(page.candidates[0]?.tokenAccounts?.[0]?.accounts[0]).toMatchObject({
      delegate: f.payer,
      delegatedAmount: 4n,
      closeAuthority: f.payer,
      nativeReserve: 2039280n,
    });
  });
  it('distinguishes successful empty results from tokens not requested', async () => {
    const chain = new Chain();
    chain.change = (method, value) =>
      method === 'getTokenAccountsByOwner' ? { ...(value as object), value: [] } : value;
    const page = await discoverBunkSolanaAccounts(seed, input(), chain.access);
    expect(page.candidates[0]?.tokenAccounts?.map((s) => s.accounts)).toEqual([[], []]);
    expect(page.inventoryComplete).toBe(false);
  });
  it.each([
    'program',
    'owner',
    'executable',
    'short data',
    'full data',
    'encoding',
    'space',
    'state',
    'option',
    'extended type',
    'duplicate',
    'missing list',
    'oversized list',
    'regressed slot',
    'unsafe slot',
  ])('rejects %s without returning partial or fabricated holdings', async (failure) => {
    const chain = new Chain();
    chain.change = (method, value) => {
      if (method !== 'getTokenAccountsByOwner') return value;
      const r = value as TokenResponse,
        row = r.value[0];
      if (!row?.account.data[0]) throw Error('missing token fixture');
      const data = base64.decode(row.account.data[0]);
      switch (failure) {
        case 'program':
          row.account.owner = f.payer;
          break;
        case 'owner':
          data.set(bunkSolanaAddressBytes(f.payer), 32);
          break;
        case 'executable':
          row.account.executable = true;
          break;
        case 'short data':
          row.account.data[0] = base64.encode(data.slice(0, 164));
          return r;
        case 'full data':
          row.account.data[0] = base64.encode(new Uint8Array(170));
          return r;
        case 'encoding':
          row.account.data[1] = 'jsonParsed';
          break;
        case 'space':
          row.account.space = 355;
          break;
        case 'state':
          data[108] = 0;
          break;
        case 'option':
          data[72] = 2;
          break;
        case 'extended type':
          if (row.account.space > 165) data[165] = 1;
          break;
        case 'duplicate':
          r.value.push(row);
          break;
        case 'missing list':
          return { context: r.context, value: null };
        case 'oversized list':
          r.value = Array(BUNK_SOLANA_TOKEN_ACCOUNT_LIMIT + 1).fill(row);
          break;
        case 'regressed slot':
          r.context.slot = 99;
          break;
        case 'unsafe slot':
          r.context.slot = Number.MAX_SAFE_INTEGER + 1;
          break;
      }
      row.account.data[0] = base64.encode(data);
      return r;
    };
    await expect(discoverBunkSolanaAccounts(seed, input(), chain.access)).rejects.toThrow();
  });
  it.each(['reorg', 'stale', 'chain', 'cancel', 'transport'])(
    'rejects %s after wallet verification and token reads',
    async (failure) => {
      const chain = new Chain(),
        controller = new AbortController();
      chain.change = (method, value) => {
        if (method === 'getTokenAccountsByOwner' && chain.tokenReads === 2) {
          if (failure === 'cancel') controller.abort();
          if (failure === 'transport') throw Error('tokens unavailable');
        }
        if (method === 'getBlock' && chain.blockReads === 6) {
          if (failure === 'reorg') return { ...(value as object), blockhash: f.payer };
          if (failure === 'stale') chain.now = 1500;
        }
        if (method === 'getGenesisHash' && chain.tokenReads === 2 && failure === 'chain')
          return f.payer;
        return value;
      };
      await expect(
        discoverBunkSolanaAccounts(seed, input(), { ...chain.access, signal: controller.signal }),
      ).rejects.toThrow(
        {
          reorg: 'scan anchor',
          stale: 'scan became stale',
          chain: 'chain changed',
          cancel: 'cancelled',
          transport: 'tokens unavailable',
        }[failure],
      );
      expect(chain.tokenReads).toBe(2);
    },
  );
  it('validates and snapshots the opt-in before any RPC', async () => {
    const chain = new Chain(),
      r = input();
    await expect(
      discoverBunkSolanaAccounts(
        seed,
        { ...r, includeTokenAccounts: 'yes' as unknown as boolean },
        chain.access,
      ),
    ).rejects.toThrow('option');
    expect(chain.calls).toBe(0);
    chain.change = (_, value) => {
      r.includeTokenAccounts = false;
      return value;
    };
    await discoverBunkSolanaAccounts(seed, r, chain.access);
    expect(chain.tokenReads).toBe(2);
  });
  it.each([899, 1206])(
    'rejects token checkpoint time %i even when the wallet checkpoint is fresh',
    async (blockTime) => {
      const chain = new Chain();
      chain.change = (method, value, params) =>
        method === 'getBlock' && params[0] === 101 ? { ...(value as object), blockTime } : value;
      await expect(discoverBunkSolanaAccounts(seed, input(), chain.access)).rejects.toThrow(
        'scan became stale',
      );
    },
  );
  it('rejects the same token account returned under both programs', async () => {
    const chain = new Chain();
    let firstAddress: string | undefined;
    chain.change = (method, value) => {
      if (method !== 'getTokenAccountsByOwner') return value;
      const r = value as TokenResponse;
      if (!r.value[0]) throw Error('missing fixture');
      if (firstAddress) r.value[0].pubkey = firstAddress;
      else firstAddress = r.value[0].pubkey;
      return r;
    };
    await expect(discoverBunkSolanaAccounts(seed, input(), chain.access)).rejects.toThrow(
      'duplicate token account',
    );
  });
  it('accepts the full account limit without dropping zero-balance records', async () => {
    const chain = new Chain();
    chain.change = (method, value) => {
      if (method !== 'getTokenAccountsByOwner') return value;
      const r = value as TokenResponse;
      r.value =
        chain.tokenReads === 1
          ? Array.from({ length: BUNK_SOLANA_TOKEN_ACCOUNT_LIMIT }, (_, i) =>
              tokenRow(f.wallet, BUNK_SOLANA_TOKEN_PROGRAMS[0], i + 1),
            )
          : [];
      return r;
    };
    const page = await discoverBunkSolanaAccounts(seed, input(), chain.access);
    expect(page.candidates[0]?.tokenAccounts?.[0]?.accounts).toHaveLength(
      BUNK_SOLANA_TOKEN_ACCOUNT_LIMIT,
    );
    expect(page.candidates[0]?.tokenAccounts?.[0]?.accounts[0]?.amount).toBe(0n);
  });
  it('does not query tokens for a wallet whose seed authority fails verification', async () => {
    const chain = new Chain();
    if (!chain.data) throw Error('missing fixture');
    chain.data[92] = (chain.data[92] ?? 0) ^ 1;
    await expect(discoverBunkSolanaAccounts(seed, input(), chain.access)).rejects.toThrow(
      'authority',
    );
    expect(chain.tokenReads).toBe(0);
  });
  it.each([0, 6, 9, 255])(
    'returns verified mint decimals %i and independent mint checkpoints',
    async (decimals) => {
      const chain = new Chain();
      for (const program of BUNK_SOLANA_TOKEN_PROGRAMS) {
        const row = mintRow(program, decimals),
          data = base64.decode(row.data[0] ?? '');
        const view = new DataView(data.buffer);
        for (const offset of [0, 46]) {
          view.setUint32(offset, 1, true);
          data.set(bunkSolanaAddressBytes(f.payer), offset + 4);
        }
        row.data[0] = base64.encode(data);
        chain.mintRecords.set(mintKey(program), row);
      }
      const page = await discoverBunkSolanaAccounts(seed, input(), chain.access);
      const tokens = page.candidates[0]?.tokenAccounts;
      expect(tokens?.map((s) => s.mintSnapshots[0]?.checkpoint.slot)).toEqual([102, 104]);
      for (const [i, snapshot] of (tokens ?? []).entries()) {
        expect(snapshot.mintSnapshots[0]?.mints).toEqual([
          {
            address: mintKey(snapshot.tokenProgram),
            status: 'initialized',
            decimals,
            supply: 0xffffffffffffffffn,
            mintAuthority: f.payer,
            freezeAuthority: f.payer,
            extended: i === 1,
          },
        ]);
      }
      expect(chain.mintRequests).toEqual(
        BUNK_SOLANA_TOKEN_PROGRAMS.map((program, i) => [
          [mintKey(program)],
          {
            commitment: 'finalized',
            encoding: 'base64',
            minContextSlot: 101 + i * 2,
            dataSlice: { offset: 0, length: 166 },
          },
        ]),
      );
    },
  );
  it('accepts a Token-2022 mint without extensions', async () => {
    const chain = new Chain(),
      program = BUNK_SOLANA_TOKEN_PROGRAMS[1];
    const row = mintRow(program),
      data = base64.decode(row.data[0] ?? '').slice(0, 82);
    row.space = 82;
    row.data[0] = base64.encode(data);
    chain.mintRecords.set(mintKey(program), row);
    const page = await discoverBunkSolanaAccounts(seed, input(), chain.access);
    expect(page.candidates[0]?.tokenAccounts?.[1]?.mintSnapshots[0]?.mints[0]).toMatchObject({
      status: 'initialized',
      extended: false,
    });
  });
  it('retains holdings when a mint is absent at the newer finalized bank', async () => {
    const chain = new Chain(),
      key = mintKey(BUNK_SOLANA_TOKEN_PROGRAMS[1]);
    chain.mintRecords.delete(key);
    const page = await discoverBunkSolanaAccounts(seed, input(), chain.access);
    const snapshot = page.candidates[0]?.tokenAccounts?.[1];
    expect(snapshot?.accounts).toHaveLength(1);
    expect(snapshot?.accounts[0]?.amount).toBe(0xffffffffffffffffn);
    expect(snapshot?.mintSnapshots[0]?.mints).toEqual([{ address: key, status: 'missing' }]);
    expect(page.inventoryComplete).toBe(false);
    expect(page.signingAuthorized).toBe(false);
  });
  it.each([
    'omitted',
    'incomplete',
    'program',
    'executable',
    'size',
    'encoding',
    'short data',
    'state',
    'mint authority',
    'freeze authority',
    'padding',
    'type',
    'regressed slot',
  ])('rejects %s mint data without fabricating decimals', async (failure) => {
    const chain = new Chain();
    chain.change = (method, value, params) => {
      if (method !== 'getMultipleAccounts' || (params[0] as string[])[0] === release.program)
        return value;
      const r = value as { context: { slot: number }; value: ReturnType<typeof mintRow>[] },
        row = r.value[0];
      if (!row?.data[0]) throw Error('missing mint fixture');
      const data = base64.decode(row.data[0]);
      switch (failure) {
        case 'omitted':
          return { ...r, value: Array(1) };
        case 'incomplete':
          r.value = [];
          break;
        case 'program':
          row.owner = f.payer;
          break;
        case 'executable':
          row.executable = true;
          break;
        case 'size':
          row.space = 165;
          break;
        case 'encoding':
          row.data[1] = 'jsonParsed';
          break;
        case 'short data':
          row.data[0] = base64.encode(data.slice(0, 81));
          return r;
        case 'state':
          data[45] = 0;
          break;
        case 'mint authority':
          data[0] = 2;
          break;
        case 'freeze authority':
          data[46] = 2;
          break;
        case 'padding':
          if (data.length > 82) data[82] = 1;
          break;
        case 'type':
          if (data.length > 82) data[165] = 2;
          break;
        case 'regressed slot':
          r.context.slot = 100;
          break;
      }
      row.data[0] = base64.encode(data);
      return r;
    };
    await expect(discoverBunkSolanaAccounts(seed, input(), chain.access)).rejects.toThrow();
  });
  it('deduplicates mints and batches all 256 distinct addresses without exceeding RPC limits', async () => {
    const chain = new Chain(),
      program = BUNK_SOLANA_TOKEN_PROGRAMS[0];
    chain.change = (method, value) => {
      if (method !== 'getTokenAccountsByOwner' || chain.tokenReads !== 1) return value;
      const r = value as TokenResponse;
      r.value = Array.from({ length: 256 }, (_, i) => {
        const row = tokenRow(f.wallet, program, i + 1),
          key = mintKey(program, i + 1);
        const data = base64.decode(row.account.data[0] ?? '');
        data.set(bunkSolanaAddressBytes(key));
        row.account.data[0] = base64.encode(data);
        chain.mintRecords.set(key, mintRow(program, i % 10));
        return row;
      });
      return r;
    };
    const page = await discoverBunkSolanaAccounts(seed, input(), chain.access);
    const batches = page.candidates[0]?.tokenAccounts?.[0]?.mintSnapshots;
    expect(batches?.map((b) => b.mints.length)).toEqual([100, 100, 56]);
    expect(batches?.flatMap((b) => b.mints.map((mint) => mint.address))).toEqual(
      Array.from({ length: 256 }, (_, i) => mintKey(program, i + 1)),
    );
    expect(chain.mintRequests.every((r) => (r[0] as string[]).length <= 100)).toBe(true);
  });
  it.each(['reorg', 'stale', 'future', 'cancel', 'transport'])(
    'rejects mint-only %s without returning a partial page',
    async (failure) => {
      const chain = new Chain(),
        controller = new AbortController();
      let mintBlockReads = 0;
      chain.change = (method, value, params) => {
        if (method === 'getMultipleAccounts' && (params[0] as string[])[0] !== release.program) {
          if (failure === 'cancel') controller.abort();
          if (failure === 'transport') throw Error('mint unavailable');
        }
        if (method === 'getBlock' && params[0] === 102) {
          mintBlockReads++;
          if (failure === 'reorg' && mintBlockReads === 2)
            return { ...(value as object), blockhash: f.payer };
          if (failure === 'stale' || failure === 'future')
            return { ...(value as object), blockTime: failure === 'stale' ? 899 : 1206 };
        }
        return value;
      };
      await expect(
        discoverBunkSolanaAccounts(seed, input(), { ...chain.access, signal: controller.signal }),
      ).rejects.toThrow(
        {
          reorg: 'scan anchor',
          stale: 'scan became stale',
          future: 'scan became stale',
          cancel: 'cancelled',
          transport: 'mint unavailable',
        }[failure],
      );
    },
  );
});
