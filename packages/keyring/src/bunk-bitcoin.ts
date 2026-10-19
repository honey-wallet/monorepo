import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import { bech32, bech32m, createBase58check } from '@scure/base';
import { BUNK_MAX_INDEX, type BunkNetwork, deriveBunkOwner } from './bunk';

export type BunkBitcoinNetwork = Extract<BunkNetwork, { family: 'bitcoin' }>['network'];
export const BITCOIN_MAX_SATOSHIS = 21_000_000n * 100_000_000n;
const MAX_INPUTS = 100;
const MAX_OUTPUTS = 33;
const doubleSha = (b: Uint8Array) => sha256(sha256(b));
const hash160 = (b: Uint8Array) => ripemd160(sha256(b));
function requireBitcoin(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(`Bunk Bitcoin: ${message}`);
}
function integer(value: number, max = 0xffffffff): number {
  requireBitcoin(Number.isSafeInteger(value) && value >= 0 && value <= max, 'invalid integer');
  return value;
}
function money(value: bigint, allowZero = false): bigint {
  requireBitcoin(
    typeof value === 'bigint' && value >= (allowZero ? 0n : 1n) && value <= BITCOIN_MAX_SATOSHIS,
    'invalid satoshi amount',
  );
  return value;
}
function hex(value: string, length: number): Uint8Array {
  requireBitcoin(
    typeof value === 'string' && new RegExp(`^[0-9a-f]{${length * 2}}$`).test(value),
    'invalid canonical hex',
  );
  return hexToBytes(value);
}
function le32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, integer(n), true);
  return b;
}
function le64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, money(n, true), true);
  return b;
}
function compact(n: number): Uint8Array {
  integer(n, 65535);
  return n < 253 ? Uint8Array.of(n) : Uint8Array.of(253, n & 255, n >>> 8);
}
function variable(b: Uint8Array): Uint8Array {
  return concatBytes(compact(b.length), b);
}
function networkPrefix(network: BunkBitcoinNetwork): string {
  requireBitcoin(['mainnet', 'testnet', 'signet', 'regtest'].includes(network), 'unknown network');
  return network === 'mainnet' ? 'bc' : network === 'regtest' ? 'bcrt' : 'tb';
}

/** Standard recipient scripts only. Testnet/signet share address prefixes: the
 * trusted chain observer must additionally bind the intended network. */
export function bunkBitcoinAddressScript(address: string, network: BunkBitcoinNetwork): string {
  const prefix = networkPrefix(network);
  requireBitcoin(
    typeof address === 'string' && address.length >= 14 && address.length <= 90,
    'invalid recipient address',
  );
  if (/^(bc|tb|bcrt)1/i.test(address)) {
    requireBitcoin(
      address === address.toLowerCase() || address === address.toUpperCase(),
      'mixed-case witness address',
    );
    const lower = address.toLowerCase();
    let decoded: { prefix: string; words: number[] }, encoding: 'bech32' | 'bech32m';
    try {
      decoded = bech32.decode(lower as `${string}1${string}`);
      encoding = 'bech32';
    } catch {
      decoded = bech32m.decode(lower as `${string}1${string}`);
      encoding = 'bech32m';
    }
    const version = decoded.words[0],
      program = bech32.fromWords(decoded.words.slice(1));
    requireBitcoin(decoded.prefix === prefix, 'recipient network mismatch');
    requireBitcoin(
      (version === 0 &&
        encoding === 'bech32' &&
        (program.length === 20 || program.length === 32)) ||
        (version === 1 && encoding === 'bech32m' && program.length === 32),
      'unsupported witness version, length or checksum',
    );
    return bytesToHex(
      concatBytes(Uint8Array.of(version === 0 ? 0 : 0x51, program.length), program),
    );
  }
  const decoder = createBase58check(sha256),
    payload = decoder.decode(address);
  requireBitcoin(
    payload.length === 21 && decoder.encode(payload) === address,
    'invalid base58 recipient',
  );
  const p2pkh = network === 'mainnet' ? 0 : 111,
    p2sh = network === 'mainnet' ? 5 : 196;
  if (payload[0] === p2pkh) return `76a914${bytesToHex(payload.slice(1))}88ac`;
  requireBitcoin(payload[0] === p2sh, 'recipient network mismatch');
  return `a914${bytesToHex(payload.slice(1))}87`;
}
function script(value: string): Uint8Array {
  requireBitcoin(
    typeof value === 'string' &&
      /^(0014[0-9a-f]{40}|0020[0-9a-f]{64}|5120[0-9a-f]{64}|76a914[0-9a-f]{40}88ac|a914[0-9a-f]{40}87)$/.test(
        value,
      ),
    'unsupported output script',
  );
  return hexToBytes(value);
}
function feeRate(rate: bigint): bigint {
  requireBitcoin(typeof rate === 'bigint' && rate > 0n && rate <= 100_000_000n, 'invalid fee rate');
  return rate;
}
/** Bitcoin Core dust policy calculation; rate is supplied by the caller/node. */
export function bunkBitcoinDust(scriptPubKey: string, dustRelayFeeSatPerKvB: bigint): bigint {
  const bytes = script(scriptPubKey),
    witness = bytes[0] === 0 || bytes[0] === 0x51;
  const size = 8 + variable(bytes).length + (witness ? 67 : 148);
  const fee = (BigInt(size) * feeRate(dustRelayFeeSatPerKvB)) / 1000n;
  return fee || 1n;
}

export interface BunkBitcoinUtxo {
  /** Display-order txid, lowercase hex without 0x. */
  txid: string;
  vout: number;
  satoshis: bigint;
  ownerIndex: number;
  scriptPubKey: string;
}
export interface BunkBitcoinInput {
  txid: string;
  vout: number;
  satoshis: bigint;
  /** Compressed SEC1 key, lowercase hex without 0x. */
  publicKey: string;
  sequence: number;
}
export interface BunkBitcoinOutput {
  satoshis: bigint;
  scriptPubKey: string;
}
export interface BunkBitcoinTransaction {
  version: 1 | 2;
  lockTime: number;
  inputs: BunkBitcoinInput[];
  outputs: BunkBitcoinOutput[];
}
function checkedTransaction(tx: BunkBitcoinTransaction): BunkBitcoinTransaction {
  requireBitcoin(tx.version === 1 || tx.version === 2, 'unsupported transaction version');
  requireBitcoin(
    Array.isArray(tx.inputs) && tx.inputs.length > 0 && tx.inputs.length <= MAX_INPUTS,
    'invalid input count',
  );
  requireBitcoin(
    Array.isArray(tx.outputs) && tx.outputs.length > 0 && tx.outputs.length <= MAX_OUTPUTS,
    'invalid output count',
  );
  const seen = new Set<string>();
  const inputs = tx.inputs.map((i) => {
    hex(i.txid, 32);
    integer(i.vout);
    money(i.satoshis);
    integer(i.sequence);
    const key = hex(i.publicKey, 33);
    requireBitcoin(
      (key[0] === 2 || key[0] === 3) && secp256k1.utils.isValidPublicKey(key),
      'invalid compressed public key',
    );
    const outpoint = `${i.txid}:${i.vout}`;
    requireBitcoin(!seen.has(outpoint), 'duplicate input');
    seen.add(outpoint);
    return {
      txid: i.txid,
      vout: i.vout,
      satoshis: i.satoshis,
      publicKey: i.publicKey,
      sequence: i.sequence,
    };
  });
  const outputs = tx.outputs.map((o) => {
    script(o.scriptPubKey);
    return { satoshis: money(o.satoshis), scriptPubKey: o.scriptPubKey };
  });
  const inputTotal = money(inputs.reduce((sum, i) => sum + i.satoshis, 0n));
  const outputTotal = money(outputs.reduce((sum, o) => sum + o.satoshis, 0n));
  requireBitcoin(outputTotal <= inputTotal, 'outputs exceed inputs');
  return { version: tx.version, lockTime: integer(tx.lockTime), inputs, outputs };
}
const outpoint = (i: BunkBitcoinInput) => concatBytes(hex(i.txid, 32).reverse(), le32(i.vout));
const outputBytes = (o: BunkBitcoinOutput) =>
  concatBytes(le64(o.satoshis), variable(script(o.scriptPubKey)));
function baseTransaction(tx: BunkBitcoinTransaction): Uint8Array {
  return concatBytes(
    le32(tx.version),
    compact(tx.inputs.length),
    ...tx.inputs.map((i) => concatBytes(outpoint(i), Uint8Array.of(0), le32(i.sequence))),
    compact(tx.outputs.length),
    ...tx.outputs.map(outputBytes),
    le32(tx.lockTime),
  );
}
function digest(tx: BunkBitcoinTransaction, inputIndex: number): Uint8Array {
  const input = tx.inputs[integer(inputIndex, tx.inputs.length - 1)];
  if (!input) throw new Error('Missing Bitcoin input');
  const scriptCode = concatBytes(
    hexToBytes('76a914'),
    hash160(hex(input.publicKey, 33)),
    hexToBytes('88ac'),
  );
  return doubleSha(
    concatBytes(
      le32(tx.version),
      doubleSha(concatBytes(...tx.inputs.map(outpoint))),
      doubleSha(concatBytes(...tx.inputs.map((i) => le32(i.sequence)))),
      outpoint(input),
      variable(scriptCode),
      le64(input.satoshis),
      le32(input.sequence),
      doubleSha(concatBytes(...tx.outputs.map(outputBytes))),
      le32(tx.lockTime),
      le32(1),
    ),
  );
}
/** BIP143 SIGHASH_ALL only. A digest is not a signing authorization. */
export function bunkBitcoinSignatureDigest(tx: BunkBitcoinTransaction, inputIndex: number): string {
  return bytesToHex(digest(checkedTransaction(tx), inputIndex));
}
function maxVbytes(tx: BunkBitcoinTransaction): number {
  // Conservative maximum witness: count + DER signature/hash type + compressed key.
  return Math.ceil((baseTransaction(tx).length * 4 + 2 + tx.inputs.length * 109) / 4);
}
export interface BunkBitcoinSpendRequest {
  network: BunkBitcoinNetwork;
  accountIndex: number;
  /** Must already be reserved as unused by the durable address allocator. */
  changeIndex: number;
  /** Caller must verify these against the intended chain, including unspent status. */
  utxos: readonly BunkBitcoinUtxo[];
  payments: readonly { address: string; satoshis: bigint }[];
  feeRateSatPerKvB: bigint;
  dustRelayFeeSatPerKvB: bigint;
  maxFeeSat: bigint;
  /** Height-based locktime, normally a recently verified chain tip. */
  lockTime: number;
}
export interface BunkBitcoinPrepared {
  transaction: BunkBitcoinTransaction;
  selected: BunkBitcoinUtxo[];
  changeAddress: string;
  changeIndex: number;
  changeSatoshis: bigint;
  feeSatoshis: bigint;
  maxVbytes: number;
  unsignedTransaction: string;
  txid: string;
  signatureDigests: string[];
  signingAuthorized: false;
}

/** Deterministic largest-owner-balance selection and fresh P2WPKH change. No network,
 * persistence or signing occurs. The journal must reserve the whole selected
 * transaction before any key is used; this helper cannot prove address freshness. */
export function prepareBunkBitcoinSpend(
  seed: Uint8Array,
  request: BunkBitcoinSpendRequest,
): BunkBitcoinPrepared {
  const prefix = networkPrefix(request.network);
  integer(request.accountIndex, BUNK_MAX_INDEX);
  integer(request.changeIndex, BUNK_MAX_INDEX);
  integer(request.lockTime, 499_999_999);
  feeRate(request.feeRateSatPerKvB);
  feeRate(request.dustRelayFeeSatPerKvB);
  money(request.maxFeeSat);
  requireBitcoin(
    Array.isArray(request.utxos) && request.utxos.length > 0 && request.utxos.length <= 256,
    'invalid UTXO set size',
  );
  requireBitcoin(
    Array.isArray(request.payments) &&
      request.payments.length > 0 &&
      request.payments.length < MAX_OUTPUTS,
    'invalid payment count',
  );
  const ref = {
    network: { family: 'bitcoin', network: request.network } as const,
    accountIndex: request.accountIndex,
  };
  const owners = new Map<number, ReturnType<typeof deriveBunkOwner>>();
  const owner = (ownerIndex: number) => {
    integer(ownerIndex, BUNK_MAX_INDEX);
    let value = owners.get(ownerIndex);
    if (!value) {
      value = deriveBunkOwner(seed, { ...ref, ownerIndex });
      owners.set(ownerIndex, value);
    }
    return value;
  };
  const change = owner(request.changeIndex),
    changeScript = `0014${change.commitment.slice(2)}`;
  requireBitcoin(change.ownerAddress.startsWith(`${prefix}1`), 'change network mismatch');
  const seen = new Set<string>();
  const candidates = request.utxos
    .map((u) => {
      hex(u.txid, 32);
      integer(u.vout);
      money(u.satoshis);
      integer(u.ownerIndex, BUNK_MAX_INDEX);
      requireBitcoin(
        u.ownerIndex < request.changeIndex,
        'change index must follow known input indices',
      );
      const id = `${u.txid}:${u.vout}`;
      requireBitcoin(!seen.has(id), 'duplicate UTXO');
      seen.add(id);
      requireBitcoin(
        u.scriptPubKey === `0014${owner(u.ownerIndex).commitment.slice(2)}`,
        'UTXO script does not match phrase',
      );
      return {
        txid: u.txid,
        vout: u.vout,
        satoshis: u.satoshis,
        ownerIndex: u.ownerIndex,
        scriptPubKey: u.scriptPubKey,
      };
    })
    .sort((a, b) => {
      if (a.satoshis !== b.satoshis) return a.satoshis > b.satoshis ? -1 : 1;
      if (a.txid !== b.txid) return a.txid < b.txid ? -1 : 1;
      return a.vout - b.vout;
    });
  money(candidates.reduce((sum, u) => sum + u.satoshis, 0n));
  const payments = request.payments.map((p) => {
    const scriptPubKey = bunkBitcoinAddressScript(p.address, request.network),
      satoshis = money(p.satoshis);
    requireBitcoin(
      satoshis >= bunkBitcoinDust(scriptPubKey, request.dustRelayFeeSatPerKvB),
      'payment below dust threshold',
    );
    requireBitcoin(scriptPubKey !== changeScript, 'payment aliases change');
    return { scriptPubKey, satoshis };
  });
  const paymentTotal = money(payments.reduce((sum, p) => sum + p.satoshis, 0n));
  const selected: BunkBitcoinUtxo[] = [],
    inputs: BunkBitcoinInput[] = [];
  // An owner reveals its public key when any input is spent. Keep all its known
  // coins together rather than leaving unselected funds under the revealed key.
  const byOwner = new Map<
    number,
    { ownerIndex: number; coins: BunkBitcoinUtxo[]; total: bigint }
  >();
  for (const u of candidates) {
    let group = byOwner.get(u.ownerIndex);
    if (!group) {
      group = { ownerIndex: u.ownerIndex, coins: [], total: 0n };
      byOwner.set(u.ownerIndex, group);
    }
    group.coins.push(u);
    group.total += u.satoshis;
  }
  const groups = [...byOwner.values()].sort((a, b) =>
    a.total === b.total ? a.ownerIndex - b.ownerIndex : a.total > b.total ? -1 : 1,
  );
  let total = 0n;
  for (const group of groups) {
    if (inputs.length + group.coins.length > MAX_INPUTS) continue;
    for (const u of group.coins) {
      selected.push(u);
      total += u.satoshis;
      inputs.push({
        txid: u.txid,
        vout: u.vout,
        satoshis: u.satoshis,
        publicKey: owner(u.ownerIndex).publicKey.slice(2),
        sequence: 0xfffffffe,
      });
    }
    const tx: BunkBitcoinTransaction = {
      version: 2,
      lockTime: request.lockTime,
      inputs: [...inputs],
      outputs: payments.map((p) => ({ ...p })),
    };
    const fee = (bytes: number) => (BigInt(bytes) * request.feeRateSatPerKvB + 999n) / 1000n;
    if (total < paymentTotal + fee(maxVbytes(tx))) continue;
    const withChange = {
      ...tx,
      outputs: [...tx.outputs, { scriptPubKey: changeScript, satoshis: 1n }],
    };
    const remaining = total - paymentTotal - fee(maxVbytes(withChange));
    const changeSatoshis =
      remaining >= bunkBitcoinDust(changeScript, request.dustRelayFeeSatPerKvB) ? remaining : 0n;
    if (changeSatoshis) tx.outputs.push({ scriptPubKey: changeScript, satoshis: changeSatoshis });
    const feeSatoshis = total - paymentTotal - changeSatoshis;
    if (feeSatoshis > request.maxFeeSat) continue;
    requireBitcoin(
      !selected.some((i) => payments.some((p) => p.scriptPubKey === i.scriptPubKey)),
      'payment would reuse an input address',
    );
    const transaction = checkedTransaction(tx),
      unsigned = baseTransaction(transaction);
    return {
      transaction,
      selected: selected.map((u) => ({ ...u })),
      changeAddress: change.ownerAddress,
      changeIndex: request.changeIndex,
      changeSatoshis,
      feeSatoshis,
      maxVbytes: maxVbytes(transaction),
      unsignedTransaction: bytesToHex(unsigned),
      txid: bytesToHex(doubleSha(unsigned).reverse()),
      signatureDigests: transaction.inputs.map((_, i) => bytesToHex(digest(transaction, i))),
      signingAuthorized: false,
    };
  }
  throw new Error('Bunk Bitcoin: insufficient eligible funds within fee/input limits');
}

/** Assemble already-authorized DER signatures (without the hash-type byte).
 * Recomputes every digest from transaction fields and verifies low-S signatures.
 * This is not a signer or a replacement for durable approval/UTXO verification. */
export function assembleBunkBitcoinTransaction(
  input: BunkBitcoinTransaction,
  signatures: readonly string[],
) {
  const tx = checkedTransaction(input);
  requireBitcoin(
    Array.isArray(signatures) && signatures.length === tx.inputs.length,
    'wrong signature count',
  );
  const witnesses = signatures.map((value, index) => {
    requireBitcoin(
      typeof value === 'string' && /^(?:[0-9a-f]{2}){8,72}$/.test(value),
      'invalid DER signature',
    );
    const signature = hexToBytes(value),
      signer = tx.inputs[index];
    requireBitcoin(
      Boolean(signer) &&
        secp256k1.verify(signature, digest(tx, index), hex(signer?.publicKey ?? '', 33), {
          prehash: false,
          lowS: true,
          format: 'der',
        }),
      'signature does not authorize transaction',
    );
    return concatBytes(
      Uint8Array.of(2),
      variable(concatBytes(signature, Uint8Array.of(1))),
      variable(hex(signer?.publicKey ?? '', 33)),
    );
  });
  const base = baseTransaction(tx);
  const raw = concatBytes(
    base.slice(0, 4),
    Uint8Array.of(0, 1),
    base.slice(4, -4),
    ...witnesses,
    base.slice(-4),
  );
  const weight = base.length * 3 + raw.length;
  return {
    rawTransaction: bytesToHex(raw),
    txid: bytesToHex(doubleSha(base).reverse()),
    wtxid: bytesToHex(doubleSha(raw).reverse()),
    weight,
    vbytes: Math.ceil(weight / 4),
  };
}
