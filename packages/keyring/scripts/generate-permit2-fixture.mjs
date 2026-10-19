// Public test key 1: fixture use only; never fund or use for a real wallet. No network access.
import { writeFileSync } from 'node:fs';
import {
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  parseAbi,
  parseAbiParameters,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`);
const a = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const now = 1900000000;
const terms = {
  chainId: '1',
  permit2: a(60),
  owner: account.address.toLowerCase(),
  token: a(20),
  amountRaw: '1000',
  spender: a(40),
  nonce: '7',
  expiration: `${now + 3600}`,
  sigDeadline: `${now + 600}`,
};
const typedData = {
  domain: { name: 'Permit2', chainId: 1, verifyingContract: terms.permit2 },
  primaryType: 'PermitSingle',
  types: {
    PermitSingle: [
      { name: 'details', type: 'PermitDetails' },
      { name: 'spender', type: 'address' },
      { name: 'sigDeadline', type: 'uint256' },
    ],
    PermitDetails: [
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
  message: {
    details: {
      token: terms.token,
      amount: terms.amountRaw,
      expiration: terms.expiration,
      nonce: terms.nonce,
    },
    spender: terms.spender,
    sigDeadline: terms.sigDeadline,
  },
};
const signature = await account.signTypedData(typedData);
const r = signature.slice(2, 66),
  s = BigInt(`0x${signature.slice(66, 130)}`),
  v = Number.parseInt(signature.slice(130), 16);
const compact = `0x${r}${(s | (BigInt(v - 27) << 255n)).toString(16).padStart(64, '0')}`;
const order = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const highS = `0x${r}${(order - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}`;
const permit = encodeAbiParameters(
  parseAbiParameters(
    '((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline),bytes',
  ),
  [
    [
      [terms.token, BigInt(terms.amountRaw), Number(terms.expiration), Number(terms.nonce)],
      terms.spender,
      BigInt(terms.sigDeadline),
    ],
    signature,
  ],
);
const swap = encodeAbiParameters(
  parseAbiParameters('address,uint256,uint256,address[],bool,uint256[]'),
  [terms.owner, 1000n, 1900n, [terms.token, a(30)], true, []],
);
const calldata = encodeFunctionData({
  abi: parseAbi(['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable']),
  functionName: 'execute',
  args: ['0x0a08', [permit, swap], BigInt(terms.sigDeadline)],
});
writeFileSync(
  new URL('../../api-client/src/fixtures/permit2.json', import.meta.url),
  `${JSON.stringify({ provenance: 'Synthetic viem 2.57.2 EIP-712 vector, public test key 1. No on-chain/provider acceptance.', now, terms, typedData, digest: hashTypedData(typedData), signature, compact, highS, calldata }, null, 2)}\n`,
);
