import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { BUNK_MAX_INDEX, deriveBunkOwner } from './bunk';
import {
  assembleBunkBitcoinTransaction,
  type BunkBitcoinNetwork,
  type BunkBitcoinPrepared,
  type BunkBitcoinSpendRequest,
  prepareBunkBitcoinSpend,
} from './bunk-bitcoin';
import { check, hash, integer } from './bunk-bitcoin-rpc';
import {
  BUNK_JOURNAL_MAX_BYTES,
  BunkJournalConflict,
  type BunkJournalStore,
  BunkSigningUncertain,
  checkBunkJournalRevision,
} from './bunk-evm-v2-journal';
import { deriveBunkJournalEncryptionKey } from './bunk-journal-key';

export interface BunkBitcoinJournalScope {
  network: BunkBitcoinNetwork;
  accountIndex: number;
}
export interface BunkBitcoinAllocation {
  id: string;
  ownerIndex: number;
  purpose: 'receive' | 'change';
}
type WireSpend = Omit<
  BunkBitcoinSpendRequest,
  'utxos' | 'payments' | 'feeRateSatPerKvB' | 'dustRelayFeeSatPerKvB' | 'maxFeeSat'
> & {
  utxos: {
    txid: string;
    vout: number;
    satoshis: string;
    ownerIndex: number;
    scriptPubKey: string;
  }[];
  payments: { address: string; satoshis: string }[];
  feeRateSatPerKvB: string;
  dustRelayFeeSatPerKvB: string;
  maxFeeSat: string;
};
interface Approval {
  id: string;
  changeAllocationId: string;
  digest: string;
  spend: WireSpend;
  unsignedTransaction: string;
  signatureDigests: string[];
  phase: 'approved' | 'claimed' | 'signed' | 'cancelled';
  signatures: string[] | null;
}
interface AccountRecord {
  format: 'honey-bitcoin-account';
  version: 1;
  key: string;
  scope: BunkBitcoinJournalScope;
  identity: string;
  nextOwnerIndex: number;
  allocations: BunkBitcoinAllocation[];
  approvals: Approval[];
}
export class BunkBitcoinHistoryRequired extends Error {
  constructor() {
    super(
      'Bitcoin allocation/approval history is missing; do not initialize a restored wallet as new',
    );
    this.name = 'BunkBitcoinHistoryRequired';
  }
}
export class BunkBitcoinArchiveReadOnly extends Error {
  constructor() {
    super('Imported Bitcoin history is read-only; an archive does not authorize new signing');
    this.name = 'BunkBitcoinArchiveReadOnly';
  }
}
/** Encrypted history snapshot, not a recovery phrase or proof of the latest revision. */
export interface BunkBitcoinJournalArchive {
  format: 'honey-bitcoin-journal-archive';
  version: 1;
  key: string;
  revision: number;
  /** Canonical base64: 24-byte nonce followed by XChaCha20-Poly1305 ciphertext/tag. */
  data: string;
}
const json = (v: unknown) => JSON.stringify(v);
const digest = (domain: string, value: unknown) =>
  bytesToHex(sha256(utf8ToBytes(json([domain, value]))));
function fields(value: unknown, names: string): asserts value is Record<string, unknown> {
  check(
    !!value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(' ') === names.split(' ').sort().join(' '),
    'invalid Bitcoin journal fields',
  );
}
function id(value: string): string {
  hash(value);
  check(value !== '0'.repeat(64), 'empty request ID');
  return value;
}
function scope(value: BunkBitcoinJournalScope): BunkBitcoinJournalScope {
  check(['mainnet', 'testnet', 'signet', 'regtest'].includes(value.network), 'unknown network');
  return { network: value.network, accountIndex: integer(value.accountIndex) };
}
function identity(seed: Uint8Array, s: BunkBitcoinJournalScope) {
  return deriveBunkOwner(seed, {
    network: { family: 'bitcoin', network: s.network },
    accountIndex: s.accountIndex,
    ownerIndex: 0,
  }).publicKey;
}
function accountKey(s: BunkBitcoinJournalScope, owner: string) {
  return `bunk-bitcoin-account:${digest('HoneyBitcoinAccountJournalV1', [s.network, s.accountIndex, owner])}`;
}
/** Wallet labels, password changes and UI aliases must not create another journal. */
export function bunkBitcoinAccountJournalKey(
  seed: Uint8Array,
  input: BunkBitcoinJournalScope,
): string {
  const s = scope(input);
  return accountKey(s, identity(seed, s));
}
function key(value: string) {
  check(
    typeof value === 'string' && /^bunk-bitcoin-account:[0-9a-f]{64}$/.test(value),
    'invalid Bitcoin journal key',
  );
}
function decimal(value: string): bigint {
  check(typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value), 'invalid stored amount');
  const n = BigInt(value);
  check(n <= 2_100_000_000_000_000n, 'stored amount exceeds supply');
  return n;
}
function wire(request: BunkBitcoinSpendRequest): WireSpend {
  const text = (n: bigint) => {
    check(typeof n === 'bigint', 'expected bigint amount');
    return n.toString();
  };
  return {
    network: request.network,
    accountIndex: request.accountIndex,
    changeIndex: request.changeIndex,
    utxos: request.utxos.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      satoshis: text(u.satoshis),
      ownerIndex: u.ownerIndex,
      scriptPubKey: u.scriptPubKey,
    })),
    payments: request.payments.map((p) => ({ address: p.address, satoshis: text(p.satoshis) })),
    feeRateSatPerKvB: text(request.feeRateSatPerKvB),
    dustRelayFeeSatPerKvB: text(request.dustRelayFeeSatPerKvB),
    maxFeeSat: text(request.maxFeeSat),
    lockTime: request.lockTime,
  };
}
function unwire(w: WireSpend): BunkBitcoinSpendRequest {
  fields(
    w,
    'network accountIndex changeIndex utxos payments feeRateSatPerKvB dustRelayFeeSatPerKvB maxFeeSat lockTime',
  );
  check(
    Array.isArray(w.utxos) &&
      w.utxos.length > 0 &&
      w.utxos.length <= 100 &&
      Array.isArray(w.payments) &&
      w.payments.length > 0 &&
      w.payments.length <= 32,
    'invalid stored spend size',
  );
  scope(w);
  integer(w.changeIndex);
  integer(w.lockTime, 499_999_999);
  const seen = new Set<string>();
  const utxos = w.utxos.map((u) => {
    fields(u, 'txid vout satoshis ownerIndex scriptPubKey');
    hash(u.txid);
    integer(u.vout, 0xffffffff);
    integer(u.ownerIndex);
    check(
      typeof u.scriptPubKey === 'string' && /^0014[0-9a-f]{40}$/.test(u.scriptPubKey),
      'invalid stored input script',
    );
    const outpoint = `${u.txid}:${u.vout}`;
    check(!seen.has(outpoint), 'duplicate stored input');
    seen.add(outpoint);
    return { ...u, satoshis: decimal(u.satoshis) };
  });
  const payments = w.payments.map((p) => {
    fields(p, 'address satoshis');
    check(typeof p.address === 'string' && p.address.length <= 90, 'invalid stored address');
    return { ...p, satoshis: decimal(p.satoshis) };
  });
  return {
    ...w,
    utxos,
    payments,
    feeRateSatPerKvB: decimal(w.feeRateSatPerKvB),
    dustRelayFeeSatPerKvB: decimal(w.dustRelayFeeSatPerKvB),
    maxFeeSat: decimal(w.maxFeeSat),
  };
}
const approvalDigest = (
  r: AccountRecord,
  a: Pick<Approval, 'changeAllocationId' | 'spend' | 'unsignedTransaction' | 'signatureDigests'>,
) =>
  digest('HoneyBitcoinApprovalV1', [
    r.key,
    a.changeAllocationId,
    a.spend,
    a.unsignedTransaction,
    a.signatureDigests,
  ]);
function decode(value: string, seed: Uint8Array): AccountRecord {
  check(
    typeof value === 'string' && value.length <= BUNK_JOURNAL_MAX_BYTES,
    'oversized Bitcoin journal',
  );
  const raw: unknown = JSON.parse(value);
  fields(raw, 'format version key scope identity nextOwnerIndex allocations approvals');
  const r = raw as unknown as AccountRecord;
  check(r.format === 'honey-bitcoin-account' && r.version === 1, 'unsupported Bitcoin journal');
  fields(r.scope, 'network accountIndex');
  const s = scope(r.scope),
    owner = identity(seed, s);
  check(r.identity === owner && r.key === accountKey(s, owner), 'foreign Bitcoin journal');
  key(r.key);
  integer(r.nextOwnerIndex);
  check(
    Array.isArray(r.allocations) &&
      r.allocations.length === r.nextOwnerIndex &&
      Array.isArray(r.approvals),
    'invalid allocation history',
  );
  const allocations = new Map<string, BunkBitcoinAllocation>();
  for (const [index, a] of r.allocations.entries()) {
    fields(a, 'id ownerIndex purpose');
    id(a.id);
    check(
      a.ownerIndex === index &&
        index < BUNK_MAX_INDEX - 1 &&
        ['receive', 'change'].includes(a.purpose) &&
        !allocations.has(a.id),
      'invalid allocation',
    );
    allocations.set(a.id, a);
  }
  const approvals = new Set<string>(),
    changes = new Set<string>(),
    owners = new Set<number>();
  for (const a of r.approvals) {
    fields(
      a,
      'id changeAllocationId digest spend unsignedTransaction signatureDigests phase signatures',
    );
    id(a.id);
    id(a.changeAllocationId);
    hash(a.digest);
    check(
      !approvals.has(a.id) && !changes.has(a.changeAllocationId),
      'duplicate approval or change reservation',
    );
    approvals.add(a.id);
    changes.add(a.changeAllocationId);
    check(
      ['approved', 'claimed', 'signed', 'cancelled'].includes(a.phase),
      'invalid approval phase',
    );
    const spend = unwire(a.spend),
      change = allocations.get(a.changeAllocationId);
    check(
      typeof a.unsignedTransaction === 'string' &&
        a.unsignedTransaction.length <= 200000 &&
        /^(?:[0-9a-f]{2}){10,}$/.test(a.unsignedTransaction) &&
        Array.isArray(a.signatureDigests) &&
        a.signatureDigests.length === spend.utxos.length,
      'invalid stored transaction',
    );
    a.signatureDigests.forEach(hash);
    check(
      !!change &&
        change.purpose === 'change' &&
        change.ownerIndex === spend.changeIndex &&
        spend.network === s.network &&
        spend.accountIndex === s.accountIndex &&
        approvalDigest(r, a) === a.digest,
      'approval binding mismatch',
    );
    for (const index of new Set(spend.utxos.map((u) => u.ownerIndex))) {
      check(index < spend.changeIndex && index < r.nextOwnerIndex, 'unallocated input owner');
      if (a.phase !== 'cancelled') {
        check(!owners.has(index), 'owner reserved twice');
        owners.add(index);
      }
    }
    if (a.phase === 'signed') {
      check(
        Array.isArray(a.signatures) &&
          a.signatures.length === spend.utxos.length &&
          a.signatures.every(
            (sig) => typeof sig === 'string' && /^(?:[0-9a-f]{2}){8,72}$/.test(sig),
          ),
        'invalid stored signatures',
      );
    } else check(a.signatures === null, 'unexpected stored signatures');
  }
  check(json(r) === value, 'noncanonical Bitcoin journal');
  return r;
}
async function withSeed<T>(
  input: Uint8Array,
  action: (seed: Uint8Array) => Promise<T>,
): Promise<T> {
  check(input instanceof Uint8Array && input.length === 64, 'expected 64-byte seed');
  const seed = input.slice();
  try {
    return await action(seed);
  } finally {
    seed.fill(0);
  }
}
async function read(store: BunkJournalStore, storageKey: string, seed: Uint8Array) {
  key(storageKey);
  const row = await store.read(storageKey);
  if (!row) throw new BunkBitcoinHistoryRequired();
  const r = decode(row.value, seed);
  check(r.key === storageKey, 'substituted Bitcoin journal');
  return { r, revision: checkBunkJournalRevision(row.revision) };
}
async function save(store: BunkJournalStore, r: AccountRecord, revision: number | null) {
  const value = json(r);
  check(
    utf8ToBytes(value).length <= BUNK_JOURNAL_MAX_BYTES,
    'Bitcoin journal capacity reached; migrate without deleting history',
  );
  if (!(await store.compareAndSwap(r.key, revision, value))) throw new BunkJournalConflict();
}
function address(seed: Uint8Array, r: AccountRecord, a: BunkBitcoinAllocation) {
  const owner = deriveBunkOwner(seed, {
    network: { family: 'bitcoin', network: r.scope.network },
    accountIndex: r.scope.accountIndex,
    ownerIndex: a.ownerIndex,
  });
  return {
    ...a,
    address: owner.ownerAddress,
    scriptPubKey: `0014${owner.commitment.slice(2)}`,
    signingAuthorized: false as const,
  };
}
function find(r: AccountRecord, approvalId: string): Approval {
  const a = r.approvals.find((a) => a.id === id(approvalId));
  check(!!a, 'unknown Bitcoin approval');
  return a;
}
function prepared(seed: Uint8Array, r: AccountRecord, a: Approval): BunkBitcoinPrepared {
  check(approvalDigest(r, a) === a.digest, 'approval digest mismatch');
  const p = prepareBunkBitcoinSpend(seed, unwire(a.spend));
  check(
    p.unsignedTransaction === a.unsignedTransaction &&
      json(p.signatureDigests) === json(a.signatureDigests),
    'approved transaction changed; explicit journal migration required',
  );
  check(
    json(wire({ ...unwire(a.spend), utxos: p.selected })) === json(a.spend),
    'stored selection changed',
  );
  return p;
}
function view(seed: Uint8Array, r: AccountRecord, a: Approval) {
  const plan = prepared(seed, r, a);
  return {
    id: a.id,
    digest: a.digest,
    phase: a.phase,
    prepared: plan,
    signed:
      a.phase === 'signed' && a.signatures
        ? assembleBunkBitcoinTransaction(plan.transaction, a.signatures)
        : null,
    signingAuthorized: false as const,
  };
}

/** Only for a newly generated wallet, never as fallback for missing/imported history.
 * Existing records are validated and retained, including after a lost write response.
 * Use an encrypted, durable, atomic store shared by all aliases of this account. */
export async function initializeBunkBitcoinJournal(
  store: BunkJournalStore,
  inputSeed: Uint8Array,
  input: BunkBitcoinJournalScope & { origin: 'new-wallet' },
) {
  check(input.origin === 'new-wallet', 'new-wallet origin required');
  const s = scope(input);
  return withSeed(inputSeed, async (seed) => {
    const owner = identity(seed, s),
      storageKey = accountKey(s, owner),
      existing = await store.read(storageKey);
    if (existing) {
      const r = decode(existing.value, seed);
      check(r.key === storageKey, 'substituted Bitcoin journal');
      return {
        key: storageKey,
        revision: checkBunkJournalRevision(existing.revision),
        nextOwnerIndex: r.nextOwnerIndex,
        signingAuthorized: false as const,
      };
    }
    const r: AccountRecord = {
      format: 'honey-bitcoin-account',
      version: 1,
      key: storageKey,
      scope: s,
      identity: owner,
      nextOwnerIndex: 0,
      allocations: [],
      approvals: [],
    };
    await save(store, r, null);
    return { key: storageKey, revision: 0, nextOwnerIndex: 0, signingAuthorized: false as const };
  });
}
export async function readBunkBitcoinJournal(
  store: BunkJournalStore,
  storageKey: string,
  seed: Uint8Array,
) {
  return withSeed(seed, async (owned) => {
    const { r, revision } = await read(store, storageKey, owned);
    return {
      key: r.key,
      revision,
      scope: { ...r.scope },
      nextOwnerIndex: r.nextOwnerIndex,
      allocations: r.allocations.map((a) => ({ ...a })),
      approvals: r.approvals.map((a) => ({ id: a.id, digest: a.digest, phase: a.phase })),
      signingAuthorized: false as const,
    };
  });
}
/** Persist allocation before revealing its address. A stable ID plus expected cursor
 * makes lost-response retries idempotent; a stale different request cannot advance it. */
export async function allocateBunkBitcoinAddress(
  store: BunkJournalStore,
  storageKey: string,
  inputSeed: Uint8Array,
  request: { id: string; expectedNextOwnerIndex: number; purpose: 'receive' | 'change' },
) {
  const requestId = id(request.id),
    cursor = integer(request.expectedNextOwnerIndex),
    purpose = request.purpose;
  check(['receive', 'change'].includes(purpose), 'invalid address purpose');
  return withSeed(inputSeed, async (seed) => {
    const { r, revision } = await read(store, storageKey, seed),
      existing = r.allocations.find((a) => a.id === requestId);
    if (existing) {
      check(
        existing.ownerIndex === cursor && existing.purpose === purpose,
        'allocation retry changed',
      );
      return address(seed, r, existing);
    }
    if (r.nextOwnerIndex !== cursor)
      throw new BunkJournalConflict('Stale Bitcoin allocation cursor; reload');
    check(cursor < BUNK_MAX_INDEX - 1, 'Bitcoin branch migration required before terminal indices');
    const a = { id: requestId, ownerIndex: cursor, purpose };
    r.allocations.push(a);
    r.nextOwnerIndex++;
    await save(store, r, revision);
    return address(seed, r, a);
  });
}
/** Durable storage of a user-approved unsigned plan, not a native signing API.
 * Caller must verify current inputs/complete owner groups and obtain approval first.
 * All selected owner keys are reserved together, even with multiple inputs per key. */
export async function reserveBunkBitcoinApproval(
  store: BunkJournalStore,
  storageKey: string,
  inputSeed: Uint8Array,
  request: { id: string; changeAllocationId: string; spend: BunkBitcoinSpendRequest },
) {
  const requestId = id(request.id),
    changeId = id(request.changeAllocationId),
    requested = wire(request.spend);
  return withSeed(inputSeed, async (seed) => {
    const { r, revision } = await read(store, storageKey, seed);
    check(
      requested.network === r.scope.network && requested.accountIndex === r.scope.accountIndex,
      'approval scope mismatch',
    );
    // The builder accepts up to 256 candidates; persisted approvals retain only its
    // selected whole-owner groups. Validate the original before narrowing the record.
    const original: BunkBitcoinSpendRequest = {
      ...requested,
      utxos: requested.utxos.map((u) => ({ ...u, satoshis: decimal(u.satoshis) })),
      payments: requested.payments.map((p) => ({ ...p, satoshis: decimal(p.satoshis) })),
      feeRateSatPerKvB: decimal(requested.feeRateSatPerKvB),
      dustRelayFeeSatPerKvB: decimal(requested.dustRelayFeeSatPerKvB),
      maxFeeSat: decimal(requested.maxFeeSat),
    };
    const p = prepareBunkBitcoinSpend(seed, original),
      a: Approval = {
        id: requestId,
        changeAllocationId: changeId,
        digest: '',
        spend: wire({ ...original, utxos: p.selected }),
        unsignedTransaction: p.unsignedTransaction,
        signatureDigests: [...p.signatureDigests],
        phase: 'approved',
        signatures: null,
      };
    a.digest = approvalDigest(r, a);
    const existing = r.approvals.find((a) => a.id === requestId);
    if (existing) {
      check(existing.digest === a.digest, 'approval retry changed');
      return view(seed, r, existing);
    }
    const change = r.allocations.find((a) => a.id === changeId);
    check(
      !!change &&
        change.purpose === 'change' &&
        change.ownerIndex === p.changeIndex &&
        !r.approvals.some((a) => a.changeAllocationId === changeId),
      'change allocation unavailable',
    );
    const reservedOwners = new Set(
      r.approvals
        .filter((a) => a.phase !== 'cancelled')
        .flatMap((a) => a.spend.utxos.map((u) => u.ownerIndex)),
    );
    for (const u of p.selected)
      check(
        u.ownerIndex < r.nextOwnerIndex && !reservedOwners.has(u.ownerIndex),
        'owner already reserved or unallocated',
      );
    r.approvals.push(a);
    await save(store, r, revision);
    return view(seed, r, a);
  });
}
export async function readBunkBitcoinApproval(
  store: BunkJournalStore,
  storageKey: string,
  inputSeed: Uint8Array,
  approvalId: string,
) {
  id(approvalId);
  return withSeed(inputSeed, async (seed) => {
    const { r } = await read(store, storageKey, seed);
    return view(seed, r, find(r, approvalId));
  });
}
/** Claim is durable before any external signature computation. A second claim is
 * uncertain, not a fresh permission. Production policy/live-chain coordination is
 * still required; this module does not derive a private key or authorize signing. */
export async function claimBunkBitcoinApproval(
  store: BunkJournalStore,
  storageKey: string,
  inputSeed: Uint8Array,
  request: { id: string; digest: string },
) {
  const approvalId = id(request.id),
    expected = hash(request.digest);
  return withSeed(inputSeed, async (seed) => {
    const { r, revision } = await read(store, storageKey, seed),
      a = find(r, approvalId);
    check(a.digest === expected, 'approval digest changed');
    prepared(seed, r, a);
    if (a.phase === 'claimed') throw new BunkSigningUncertain();
    check(a.phase === 'approved', 'approval is not claimable');
    a.phase = 'claimed';
    await save(store, r, revision);
    return view(seed, r, a);
  });
}
export async function cancelBunkBitcoinApproval(
  store: BunkJournalStore,
  storageKey: string,
  inputSeed: Uint8Array,
  request: { id: string; digest: string },
) {
  const approvalId = id(request.id),
    expected = hash(request.digest);
  return withSeed(inputSeed, async (seed) => {
    const { r, revision } = await read(store, storageKey, seed),
      a = find(r, approvalId);
    check(a.digest === expected, 'approval digest changed');
    if (a.phase === 'cancelled') return;
    check(a.phase === 'approved', 'claimed or signed approval cannot be cancelled');
    a.phase = 'cancelled';
    await save(store, r, revision);
  });
}
/** Store externally produced signatures only for the exact claimed plan. Verify
 * all DER signatures and persist before returning raw bytes. Never replace saved
 * signatures, release owner claims after confirmation/reorg, or reset on failure. */
export async function persistBunkBitcoinSignatures(
  store: BunkJournalStore,
  storageKey: string,
  inputSeed: Uint8Array,
  request: { id: string; digest: string; signatures: readonly string[] },
) {
  const approvalId = id(request.id),
    expected = hash(request.digest),
    signatures = [...request.signatures];
  return withSeed(inputSeed, async (seed) => {
    const { r, revision } = await read(store, storageKey, seed),
      a = find(r, approvalId);
    check(a.digest === expected, 'approval digest changed');
    check(a.phase === 'claimed' || a.phase === 'signed', 'approval was not claimed');
    assembleBunkBitcoinTransaction(prepared(seed, r, a).transaction, signatures);
    if (a.phase === 'signed') {
      check(json(a.signatures) === json(signatures), 'saved signatures cannot be replaced');
      return view(seed, r, a);
    }
    a.signatures = signatures;
    a.phase = 'signed';
    await save(store, r, revision);
    return view(seed, r, a);
  });
}

function archiveAad(storageKey: string, revision: number): Uint8Array {
  key(storageKey);
  checkBunkJournalRevision(revision);
  // Separate domain from local encrypted rows: neither format can substitute for
  // the other even though both derive encryption from the same recovered phrase.
  return utf8ToBytes(`honey-bunk-bitcoin-archive-v1:${storageKey}:${revision}`);
}

/** Export one atomic journal snapshot without mutating the live account. Use a
 * cryptographic random source. The archive is encrypted with the phrase-derived
 * journal key even if the caller's unlocked source uses an older random vault key.
 * Refresh after state changes; no snapshot can prove that later approvals do not exist. */
export async function exportBunkBitcoinJournalArchive(
  store: BunkJournalStore,
  storageKey: string,
  inputSeed: Uint8Array,
  random: (length: number) => Uint8Array,
): Promise<BunkBitcoinJournalArchive> {
  return withSeed(inputSeed, async (seed) => {
    const { r, revision } = await read(store, storageKey, seed);
    const additional = archiveAad(storageKey, revision);
    const supplied = random(24);
    check(supplied instanceof Uint8Array && supplied.length === 24, 'invalid archive nonce');
    const nonce = supplied.slice();
    const plain = utf8ToBytes(json(r));
    let encryptionKey: Uint8Array | undefined;
    try {
      check(plain.length <= BUNK_JOURNAL_MAX_BYTES, 'oversized Bitcoin archive');
      encryptionKey = deriveBunkJournalEncryptionKey(seed);
      const sealed = xchacha20poly1305(encryptionKey, nonce, additional).encrypt(plain);
      const bytes = new Uint8Array(nonce.length + sealed.length);
      bytes.set(nonce);
      bytes.set(sealed, nonce.length);
      return {
        format: 'honey-bitcoin-journal-archive',
        version: 1,
        key: storageKey,
        revision,
        data: base64.encode(bytes),
      };
    } finally {
      encryptionKey?.fill(0);
      plain.fill(0);
    }
  });
}

/** Bounds and copies an archive envelope. This does not authenticate its contents. */
export function checkBunkBitcoinJournalArchive(input: unknown): BunkBitcoinJournalArchive {
  fields(input, 'format version key revision data');
  const archive = input as unknown as BunkBitcoinJournalArchive;
  check(
    archive.format === 'honey-bitcoin-journal-archive' && archive.version === 1,
    'unsupported Bitcoin archive',
  );
  const storageKey = archive.key,
    revision = checkBunkJournalRevision(archive.revision),
    encoded = archive.data;
  archiveAad(storageKey, revision);
  check(
    typeof encoded === 'string' &&
      encoded.length >= 56 &&
      encoded.length <= Math.ceil((BUNK_JOURNAL_MAX_BYTES + 40) / 3) * 4,
    'invalid Bitcoin archive size',
  );
  const bytes = base64.decode(encoded);
  check(
    base64.encode(bytes) === encoded &&
      bytes.length >= 40 &&
      bytes.length <= BUNK_JOURNAL_MAX_BYTES + 40,
    'invalid Bitcoin archive encoding',
  );
  return { format: archive.format, version: 1, key: storageKey, revision, data: encoded };
}

/** Authenticate and inspect an archive without installing it into any writable DB.
 * The returned store supports existing journal/approval readers and exact saved
 * transaction submission. EVERY write rejects, including claims and allocations.
 * A valid old archive is still old: preserve current history and use a separate
 * restore/device-authority policy before permitting new signing. Call destroy on lock.
 * JavaScript strings cannot be reliably zeroized; destroy drops the retained record. */
export function openBunkBitcoinJournalArchive(input: unknown, inputSeed: Uint8Array) {
  const archive = checkBunkBitcoinJournalArchive(input);
  const storageKey = archive.key,
    revision = archive.revision,
    additional = archiveAad(storageKey, revision),
    bytes = base64.decode(archive.data);
  check(inputSeed instanceof Uint8Array && inputSeed.length === 64, 'expected 64-byte seed');
  const seed = inputSeed.slice();
  let encryptionKey: Uint8Array | undefined, plain: Uint8Array | undefined;
  try {
    encryptionKey = deriveBunkJournalEncryptionKey(seed);
    plain = xchacha20poly1305(encryptionKey, bytes.subarray(0, 24), additional).decrypt(
      bytes.subarray(24),
    );
    let value: string | null = new TextDecoder('utf-8', { fatal: true }).decode(plain);
    const r = decode(value, seed);
    check(r.key === storageKey, 'substituted Bitcoin archive');
    const store: BunkJournalStore & { destroy(): void } = {
      async read(requestedKey) {
        key(requestedKey);
        check(value !== null, 'Bitcoin archive is closed');
        return requestedKey === storageKey ? { revision, value } : null;
      },
      async compareAndSwap() {
        throw new BunkBitcoinArchiveReadOnly();
      },
      destroy() {
        value = null;
      },
    };
    return {
      key: storageKey,
      revision,
      scope: { ...r.scope },
      store,
      historyComplete: false as const,
      signingAuthorized: false as const,
    };
  } finally {
    encryptionKey?.fill(0);
    plain?.fill(0);
    seed.fill(0);
  }
}
