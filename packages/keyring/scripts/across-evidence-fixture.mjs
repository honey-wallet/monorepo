// Reproducible synthetic ABI fixture. No RPC, wallet key or funds.
// ABI checked against Across contracts commit 950e9154f3d61e59590eb7d4403fae5d3cae84f8.
import { writeFileSync } from 'node:fs';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
} from 'viem';

const a = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const w = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const sourceHash = `0x${'11'.repeat(32)}`;
const fillHash = `0x${'22'.repeat(32)}`;
const blockHash = `0x${'aa'.repeat(32)}`;
const abi = parseAbi([
  'function deposit(bytes32 depositor,bytes32 recipient,bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 destinationChainId,bytes32 exclusiveRelayer,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityParameter,bytes message)',
  'event FundsDeposited(bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 indexed destinationChainId,uint256 indexed depositId,uint32 quoteTimestamp,uint32 fillDeadline,uint32 exclusivityDeadline,bytes32 indexed depositor,bytes32 recipient,bytes32 exclusiveRelayer,bytes message)',
  'event FilledRelay(bytes32 inputToken,bytes32 outputToken,uint256 inputAmount,uint256 outputAmount,uint256 repaymentChainId,uint256 indexed originChainId,uint256 indexed depositId,uint32 fillDeadline,uint32 exclusivityDeadline,bytes32 exclusiveRelayer,bytes32 indexed relayer,bytes32 depositor,bytes32 recipient,bytes32 messageHash,(bytes32 updatedRecipient,bytes32 updatedMessageHash,uint256 updatedOutputAmount,uint8 fillType) relayExecutionInfo)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);
const calldata = encodeFunctionData({
  abi,
  functionName: 'deposit',
  args: [w(1), w(2), w(3), w(4), 1000000n, 990000n, 8453n, w(6), 1699999900, 1700003600, 60, '0x'],
});
const log = (hash, index, address, topics, data) => ({
  address,
  topics,
  data,
  transactionHash: hash,
  blockHash,
  blockNumber: '0xa',
  transactionIndex: '0x0',
  logIndex: `0x${index.toString(16)}`,
  removed: false,
});
const transfer = (hash, index, token, from, to, amount) =>
  log(
    hash,
    index,
    token,
    encodeEventTopics({ abi, eventName: 'Transfer', args: { from, to } }),
    encodeAbiParameters(parseAbiParameters('uint256'), [amount]),
  );
const sourceLogs = [
  transfer(sourceHash, 2, a(3), a(1), a(5), 1000000n),
  log(
    sourceHash,
    3,
    a(5),
    encodeEventTopics({
      abi,
      eventName: 'FundsDeposited',
      args: { destinationChainId: 8453n, depositId: 7n, depositor: w(1) },
    }),
    encodeAbiParameters(
      parseAbiParameters(
        'bytes32,bytes32,uint256,uint256,uint32,uint32,uint32,bytes32,bytes32,bytes',
      ),
      [w(3), w(4), 1000000n, 990000n, 1699999900, 1700003600, 1700000060, w(2), w(6), '0x'],
    ),
  ),
];
const fillLogs = [
  log(
    fillHash,
    2,
    a(5),
    encodeEventTopics({
      abi,
      eventName: 'FilledRelay',
      args: { originChainId: 1n, depositId: 7n, relayer: w(8) },
    }),
    encodeAbiParameters(
      parseAbiParameters(
        'bytes32,bytes32,uint256,uint256,uint256,uint32,uint32,bytes32,bytes32,bytes32,bytes32,(bytes32,bytes32,uint256,uint8)',
      ),
      [
        w(3),
        w(4),
        1000000n,
        990000n,
        1n,
        1700003600,
        1700000060,
        w(6),
        w(1),
        w(2),
        w(0),
        [w(2), w(0), 990000n, 0],
      ],
    ),
  ),
  transfer(fillHash, 3, a(4), a(8), a(2), 990000n),
];
const receipt = (hash, from, logs) => ({
  transactionHash: hash,
  from,
  to: a(5),
  status: '0x1',
  blockNumber: '0xa',
  blockHash,
  transactionIndex: '0x0',
  contractAddress: null,
  logs,
});
const result = {
  provenance:
    'Synthetic viem 2.57.2 ABI encoding; not observed chain transactions or production registry approval.',
  terms: {
    sourceChain: '1',
    destinationChain: '8453',
    depositor: a(1),
    recipient: a(2),
    inputToken: a(3),
    outputToken: a(4),
    inputAmount: '1000000',
    outputAmount: '990000',
    exclusiveRelayer: a(6),
    quoteTimestamp: '1699999900',
    fillDeadline: '1700003600',
    exclusivityParameter: '60',
  },
  calldata,
  sourceTransaction: {
    hash: sourceHash,
    from: a(1),
    to: a(5),
    chainId: '0x1',
    value: '0x0',
    input: calldata,
    blockNumber: '0xa',
    blockHash,
  },
  sourceReceipt: receipt(sourceHash, a(1), sourceLogs),
  fillReceipt: receipt(fillHash, a(8), fillLogs),
};
writeFileSync(
  new URL('../../../apps/server/tests/fixtures/across-direct-evidence.json', import.meta.url),
  `${JSON.stringify(result, null, 2)}\n`,
);
