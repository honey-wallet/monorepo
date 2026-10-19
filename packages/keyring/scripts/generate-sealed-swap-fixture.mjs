// Offline fixture. Public scalar 1; no RPC, wallet, environment or real funds.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
} from 'viem';
import { permit2TypedData } from '../../api-client/src/permit2.ts';
import { evmAddressOfKey, signEvmTransaction, signEvmTypedData } from '../src/sign.ts';

const key = new Uint8Array(32);
key[31] = 1;
const owner = evmAddressOfKey(key).toLowerCase();
const a = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const now = 1900000000;
const terms = {
  chainId: '31337',
  permit2: a(60),
  owner,
  token: a(20),
  amountRaw: '1000',
  spender: a(40),
  nonce: '7',
  expiration: `${now + 600}`,
  sigDeadline: `${now + 600}`,
};
const signature = await signEvmTypedData(key, permit2TypedData(terms, now));
const enc = (type, values) => encodeAbiParameters(parseAbiParameters(type), values);
const data = encodeFunctionData({
  abi: parseAbi(['function execute(bytes,bytes[],uint256) payable']),
  functionName: 'execute',
  args: [
    '0x0a00',
    [
      enc('((address,uint160,uint48,uint48),address,uint256),bytes', [
        [[a(20), 1000n, now + 600, 7], a(40), BigInt(now + 600)],
        signature,
      ]),
      enc('address,uint256,uint256,bytes,bool,uint256[]', [
        owner,
        1000n,
        1900n,
        `${a(20)}000bb8${a(30).slice(2)}`,
        true,
        [],
      ]),
    ],
    BigInt(now + 600),
  ],
});
const steps = [{ purpose: 'action', to: a(40), valueRaw: '0', data }];
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
const hash = (v) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(v)))
    .digest('hex');
const prepared = {
  plan: {
    schemaVersion: 1,
    provider: 'uniswap',
    chainId: '31337',
    signer: owner,
    intentHash: 'a'.repeat(64),
    registryRevision: 'synthetic-test-only',
    feePolicyRevision: 'synthetic-zero-fees',
    quoteReference: 'synthetic-quote',
    expiresAtMs: (now + 600) * 1000,
    maximumNetworkFeeRaw: '1000000000000000',
    maximumSpend: { assetAddress: a(20), amountRaw: '1000', recipient: owner },
    minimumReceive: { assetAddress: a(30), amountRaw: '1900', recipient: owner },
    fees: [],
    simulation: {
      blockNumber: '10',
      blockHash: `0x${'bb'.repeat(32)}`,
      callsHash: hash(steps),
      observedAtMs: now * 1000,
    },
    steps,
  },
  firstNonce: '7',
  gasLimits: ['500000'],
  maxFeePerGas: '2000000000',
  maxPriorityFeePerGas: '1000000000',
};
const transaction = {
  type: 'eip1559',
  chainId: 31337,
  nonce: 7,
  gas: 500000n,
  maxFeePerGas: 2000000000n,
  maxPriorityFeePerGas: 1000000000n,
  to: a(40),
  value: 0n,
  data,
};
const signed = await signEvmTransaction(key, transaction);
const variants = {};
for (const [name, change] of Object.entries({
  lowerGas: { gas: 450000n },
  lowerFee: { maxFeePerGas: 1900000000n },
  changedNonce: { nonce: 8 },
}))
  variants[name] = await signEvmTransaction(key, { ...transaction, ...change });
writeFileSync(
  new URL('../../../apps/server/tests/fixtures/sealed-swap-viem.json', import.meta.url),
  `${JSON.stringify({ source: 'Offline viem 2.57.2, public scalar1. Storage fixture, not execution acceptance.', prepared, terms, signature, signed, variants, transactionHash: keccak256(signed) }, null, 2)}\n`,
);
key.fill(0);
