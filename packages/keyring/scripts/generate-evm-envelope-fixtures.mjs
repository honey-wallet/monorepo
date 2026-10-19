// Offline cross-language fixtures only. Public test scalar 1 (and 2 for mismatch),
// synthetic chain 31337. Never load a wallet, .env, RPC URL or live account here.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fromRlp, keccak256, parseTransaction, toHex, toRlp } from 'viem';
import { evmAddressOfKey, signEvmTransaction } from '../src/sign.ts';

const key = new Uint8Array(32);
key[31] = 1;
const other = new Uint8Array(32);
other[31] = 2;
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
const digest = (v) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
const steps = [
  {
    purpose: 'approval',
    to: `0x${'22'.repeat(20)}`,
    valueRaw: '0',
    data: `0x095ea7b3${'00'.repeat(64)}`,
  },
  { purpose: 'action', to: `0x${'33'.repeat(20)}`, valueRaw: '0', data: '0x12345678' },
];
const signer = evmAddressOfKey(key).toLowerCase();
const nowMs = 1792314500000;
const plan = {
  schemaVersion: 1,
  provider: 'aave_v3',
  chainId: '31337',
  signer,
  intentHash: 'a'.repeat(64),
  registryRevision: 'synthetic-test-only',
  feePolicyRevision: 'synthetic-zero-app-fee',
  quoteReference: null,
  expiresAtMs: nowMs + 120000,
  maximumNetworkFeeRaw: '500000000000000',
  maximumSpend: { assetAddress: steps[0].to, amountRaw: '9007199254740993', recipient: signer },
  minimumReceive: null,
  fees: [],
  simulation: {
    blockNumber: '10',
    blockHash: `0x${'bb'.repeat(32)}`,
    callsHash: digest(steps),
    observedAtMs: nowMs - 1000,
  },
  steps,
};
const transaction = (i) => ({
  type: 'eip1559',
  chainId: 31337,
  nonce: 7 + i,
  gas: i === 0 ? 100000n : 120000n,
  maxFeePerGas: 2000000000n,
  maxPriorityFeePerGas: 1000000000n,
  to: steps[i].to,
  value: BigInt(steps[i].valueRaw),
  data: steps[i].data,
  accessList: [],
});
const signed = await Promise.all([0, 1].map((i) => signEvmTransaction(key, transaction(i))));
const variants = {};
for (const [name, changes] of Object.entries({
  wrong_chain: { chainId: 31338 },
  wrong_nonce: { nonce: 8 },
  wrong_to: { to: steps[1].to },
  wrong_data: { data: '0x1234' },
  wrong_value: { value: 1n },
  contract_creation: { to: undefined },
  access_list: { accessList: [{ address: steps[0].to, storageKeys: [`0x${'00'.repeat(32)}`] }] },
  low_gas: { gas: 21000n },
  high_gas: { gas: 500001n },
  bundle_fee_exceeded: { maxFeePerGas: 3000000000n },
  wide_value: { value: 9007199254740993n },
}))
  variants[name] = await signEvmTransaction(key, { ...transaction(0), ...changes });
variants.wrong_signer = await signEvmTransaction(other, transaction(0));
// Signature malleation preserves recovered key unless low-S is explicitly enforced.
const parsed = parseTransaction(signed[0]);
const order = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const fields = fromRlp(`0x${signed[0].slice(4)}`);
const modify = (index, value) => {
  const copy = [...fields];
  copy[index] = value;
  return `0x02${toRlp(copy).slice(2)}`;
};
const high = [...fields];
high[9] = parsed.yParity === 0 ? '0x01' : '0x';
high[11] = toHex(order - BigInt(parsed.s));
variants.high_s = `0x02${toRlp(high).slice(2)}`;
variants.zero_r = modify(10, '0x');
variants.invalid_parity = modify(9, '0x02');
variants.noncanonical_nonce = modify(1, '0x0007');
variants.priority_above_max = modify(2, toHex(3000000000n));
variants.trailing_byte = `${signed[0]}00`;
variants.p2p_wrapper = toRlp(signed[0]);
variants.unsigned = `0x02${toRlp(fields.slice(0, 9)).slice(2)}`;
const fixture = {
  generator: 'Honey keyring signEvmTransaction / viem 2.57.2, offline synthetic chain 31337',
  nowMs,
  plan,
  preparationHash: digest(plan),
  policy: { firstNonce: 7, maximumGasPerTransaction: 500000 },
  signed,
  transactionHashes: signed.map(keccak256),
  maximumExecutionFee: '440000000000000',
  variants,
};
writeFileSync(
  new URL('../../../apps/server/tests/fixtures/evm-envelopes-viem.json', import.meta.url),
  `${JSON.stringify(fixture, null, 2)}\n`,
);
key.fill(0);
other.fill(0);
console.log('Wrote offline signed-envelope fixtures; no network requests or real wallet keys.');
