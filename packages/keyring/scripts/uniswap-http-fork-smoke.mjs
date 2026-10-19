// Actual-contract HTTP/worker acceptance. No configurable URL, wallet or key.
// Writes only to literal localhost chain 31337; provider responses are synthetic.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
} from 'viem';
import { createApiClient } from '../../api-client/src/client.ts';
import { permit2TypedData } from '../../api-client/src/permit2.ts';
import {
  swapTransactionRequests,
  validateSwapReview,
  validateSwapSigning,
} from '../../api-client/src/swap-execution.ts';
import {
  evmAddressOfKey,
  signEvmMessage,
  signEvmTransaction,
  signEvmTypedData,
} from '../src/sign.ts';

const flags = new Set(process.argv.slice(2));
assert.ok(
  [...flags].every((f) => ['--fees', '--drop-ack', '--unfillable'].includes(f)),
  'only fixed scenario flags are accepted',
);
const withFees = flags.has('--fees');
const dropAck = flags.has('--drop-ack');
const unfillable = flags.has('--unfillable');
assert.ok(!unfillable || (!withFees && !dropAck), 'unfillable is a separate negative scenario');
const recipients = [
  '0x0000000000000000000000000000000000000032',
  '0x000000000000000000000000000000000000003c',
];
const root = fileURLToPath(new URL('../../../', import.meta.url));
const rpc = async (method, params = []) => {
  const response = await fetch('http://127.0.0.1:28545', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(45000),
    redirect: 'error',
  });
  assert.equal(response.status, 200);
  const r = await response.json();
  assert.equal(r.error, undefined, `RPC ${method}: ${JSON.stringify(r.error)}`);
  return r.result;
};
const databaseCommand = (input) => {
  const r = spawnSync(join(root, 'target/debug/examples/aave_fork_prepare'), [], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 65000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const tokenIn = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const tokenOut = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const funder = '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c';
const router = '0x23617e59a5925b2a4bf75d73ff6711cd0b29de85';
const permit2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const quoter = '0x61ffe014ba17989e743c5f6cb21bf9697530b21e';
const v3Factory = '0x1f98431c8ad98523631ae4a59f267346ea31f984';
const abi = parseAbi([
  'function transfer(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function execute(bytes,bytes[],uint256) payable',
]);
const permitAbi = parseAbi([
  'function allowance(address,address,address) view returns (uint160,uint48,uint48)',
]);
const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)',
]);
const read = async (to, abi, functionName, args) =>
  decodeFunctionResult({
    abi,
    functionName,
    data: await rpc('eth_call', [
      { to, data: encodeFunctionData({ abi, functionName, args }) },
      'latest',
    ]),
  });
const enc = (types, args) => encodeAbiParameters(parseAbiParameters(types), args);
const key = new Uint8Array(32);
key[31] = 1; // Public test scalar, never user custody.
const signer = evmAddressOfKey(key).toLowerCase();
const api = createApiClient({ baseUrl: 'http://127.0.0.1:28546' });
assert.match(await rpc('web3_clientVersion'), /^anvil\//);
assert.equal(await rpc('eth_chainId'), '0x7a69');
const fork = await rpc('eth_getBlockByNumber', ['latest', false]);
assert.equal(BigInt(fork.number), 26218343n, 'requires a fresh documented fork');
const snapshot = await rpc('evm_snapshot');
const dir = await mkdtemp(join(tmpdir(), 'honey-uniswap-http-'));
let database, server, provider, rpcProxy, providerError;
let lostAcknowledgement = null;
const broadcasts = [];
let quoteCalls = 0,
  buildCalls = 0;
const pause = () => new Promise((r) => setTimeout(r, 1000));
async function poll(fn, accept, limit = 180) {
  let last;
  for (let n = 0; n < limit; n++) {
    if (providerError) throw providerError;
    last = await fn();
    if (accept(last)) return last;
    if (last?.operation?.state === 'failed')
      throw new Error('Operation failed before expected state');
    await pause();
  }
  throw new Error(`Polling deadline: ${JSON.stringify(last)}`);
}
async function stop() {
  if (!server) return;
  const child = server;
  server = null;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await exit;
}
const pin = async (address) => {
  const code = await rpc('eth_getCode', [address, 'latest']);
  assert.notEqual(code, '0x');
  return { address, codeHash: keccak256(code) };
};
try {
  database = databaseCommand({ command: 'init_database' }).database;
  await rpc('anvil_setCode', [signer, '0x']);
  await rpc('anvil_setBalance', [signer, '0xde0b6b3a7640000']);
  await rpc('anvil_setBalance', [funder, '0xde0b6b3a7640000']);
  // Align local block clock with the wall-clock authenticated review; snapshot restores it.
  await rpc('evm_setNextBlockTimestamp', [Math.floor(Date.now() / 1000)]);
  await rpc('anvil_impersonateAccount', [funder]);
  try {
    const hash = await rpc('eth_sendTransaction', [
      {
        from: funder,
        to: tokenIn,
        gas: '0x30d40',
        data: encodeFunctionData({ abi, functionName: 'transfer', args: [signer, 10000000n] }),
      },
    ]);
    assert.equal(
      (
        await poll(
          () => rpc('eth_getTransactionReceipt', [hash]),
          (v) => v !== null,
          30,
        )
      ).status,
      '0x1',
    );
  } finally {
    await rpc('anvil_stopImpersonatingAccount', [funder]);
  }
  const word = await rpc('eth_getStorageAt', [
    tokenIn,
    '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3',
    'latest',
  ]);
  assert.match(word, /^0x0{24}[0-9a-f]{40}$/i);
  // Observed pins are acceptance-fixture data, not production registry approval.
  const registry = {
    chainId: 31337,
    router: await pin(router),
    permit2: await pin(permit2),
    v2Factory: await pin('0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f'),
    v3Factory: await pin(v3Factory),
    poolManager: await pin('0x000000000004444c5dc75cb358380d2e3de08a90'),
    wrappedNative: await pin(tokenOut),
    tokens: [
      {
        contract: await pin(tokenIn),
        decimals: 6,
        allowEmptyApprovalReturn: false,
        code: { kind: 'usdc', implementation: await pin(`0x${word.slice(-40)}`) },
      },
      {
        contract: await pin(tokenOut),
        decimals: 18,
        allowEmptyApprovalReturn: false,
        code: { kind: 'direct' },
      },
    ],
    registryRevision: 'observed-local-router-212',
    feePolicyRevision: withFees ? 'local-two-percent-fees' : 'local-zero-fees',
    maximumGasPerTransaction: 1500000,
    maximumQuoteBlockLag: 128,
  };
  const quoteConfigFile = join(dir, 'quotes.json');
  await writeFile(
    quoteConfigFile,
    JSON.stringify({
      apiKey: 'local-fixture-only',
      accountScope: 'local-aave-fork',
      intervalMs: 167,
      chainId: 31337,
      router,
      permit2,
      tokens: [
        { address: tokenIn, symbol: 'USDC', decimals: 6 },
        { address: tokenOut, symbol: 'WETH', decimals: 18 },
      ],
      integratorFees: withFees ? recipients.map((recipient) => ({ recipient, bps: 100 })) : [],
      registryRevision: registry.registryRevision,
      feePolicyRevision: registry.feePolicyRevision,
    }),
    { mode: 0o600 },
  );
  const configFile = join(dir, 'execution.json');
  await writeFile(
    configFile,
    JSON.stringify({
      mode: 'local_fork',
      rpcUrl: dropAck ? 'http://127.0.0.1:28548' : 'http://127.0.0.1:28545',
      rpcBudget: { scope: 'local-aave-fork', intervalMs: 10, simulationCost: 10 },
      registry,
      quoteConfigFile,
      fixtureOrigin: 'http://127.0.0.1:28547',
      maximumFeeRoundingRaw: withFees ? 1 : 0,
      activeKeyId: 'public-test-only',
      dataKeys: { 'public-test-only': '55'.repeat(32) },
    }),
    { mode: 0o600 },
  );
  const amount = 1000000n;
  if (dropAck) {
    // Forward to the owned fork, then deliberately lose one successful broadcast response.
    // This models unknown send outcome without modifying application receipt/finality rules.
    rpcProxy = createServer(async (req, res) => {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          assert.ok(size <= 1048576);
          chunks.push(chunk);
        }
        const request = JSON.parse(Buffer.concat(chunks));
        const upstream = await fetch('http://127.0.0.1:28545', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(45000),
          redirect: 'error',
        });
        const response = await upstream.json();
        if (request.method === 'eth_sendRawTransaction') {
          assert.equal(response.error, undefined);
          broadcasts.push(response.result);
          if (lostAcknowledgement === null) {
            lostAcknowledgement = response.result;
            res.destroy();
            return;
          }
        }
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (error) {
        providerError = error;
        res.destroy();
      }
    });
    await new Promise((resolve, reject) => {
      rpcProxy.once('error', reject);
      rpcProxy.listen(28548, '127.0.0.1', resolve);
    });
  }
  const pool = (
    await read(v3Factory, factoryAbi, 'getPool', [tokenIn, tokenOut, 3000])
  ).toLowerCase();
  assert.notEqual(pool, '0x0000000000000000000000000000000000000000');
  let quoteResponse, permitTerms;
  provider = createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.headers['x-api-key'], 'local-fixture-only');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        assert.ok(bytes <= 262144);
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks));
      let result;
      if (req.url === '/quote') {
        quoteCalls++;
        assert.equal(body.swapper.toLowerCase(), signer);
        assert.equal(body.amount, amount.toString());
        assert.equal(body.tokenInChainId, 31337);
        const quoted = (
          await read(quoter, quoterAbi, 'quoteExactInputSingle', [
            [tokenIn, tokenOut, amount, 3000, 0n],
          ])
        )[0];
        const output = unfillable ? quoted * 2n : quoted;
        const allowance = await read(permit2, permitAbi, 'allowance', [signer, tokenIn, router]);
        const deadline = String(Math.floor(Date.now() / 1000) + 600);
        permitTerms = {
          chainId: '31337',
          permit2,
          owner: signer,
          token: tokenIn,
          amountRaw: amount.toString(),
          spender: router,
          nonce: allowance[2].toString(),
          expiration: deadline,
          sigDeadline: deadline,
        };
        const typed = JSON.parse(permit2TypedData(permitTerms));
        const { EIP712Domain: _domain, ...types } = typed.types;
        const block = await rpc('eth_getBlockByNumber', ['latest', false]);
        const net = withFees ? output - 2n * (output / 100n) : output;
        quoteResponse = {
          requestId: 'local-quote',
          routing: 'CLASSIC',
          permitData: { domain: typed.domain, types, values: typed.message },
          quote: {
            quoteId: 'local-v3',
            tradeType: 'EXACT_INPUT',
            chainId: 31337,
            swapper: signer,
            slippage: 1,
            blockNumber: BigInt(block.number).toString(),
            gasFee: '1000000000000000',
            txFailureReasons: [],
            input: { token: tokenIn, amount: amount.toString() },
            output: { token: tokenOut, amount: output.toString(), recipient: signer },
            aggregatedOutputs: [
              {
                token: tokenOut,
                amount: net.toString(),
                minAmount: ((net * 99n) / 100n).toString(),
                recipient: signer,
              },
              ...(withFees
                ? recipients.map((recipient) => ({
                    token: tokenOut,
                    amount: (output / 100n).toString(),
                    recipient,
                    fee: 'INTEGRATOR',
                    bps: 100,
                  }))
                : []),
            ],
            route: [
              [
                {
                  type: 'v3-pool',
                  address: pool,
                  amountIn: amount.toString(),
                  amountOut: output.toString(),
                  tokenIn: { address: tokenIn, chainId: 31337, decimals: '6' },
                  tokenOut: { address: tokenOut, chainId: 31337, decimals: '18' },
                },
              ],
            ],
          },
        };
        result = quoteResponse;
      } else {
        assert.equal(req.url, '/swap');
        buildCalls++;
        assert.deepEqual(body.quote, quoteResponse.quote);
        assert.equal(body.simulateTransaction, false);
        const permitInput = enc('((address,uint160,uint48,uint48),address,uint256),bytes', [
          [
            [tokenIn, amount, Number(permitTerms.expiration), Number(permitTerms.nonce)],
            router,
            BigInt(permitTerms.sigDeadline),
          ],
          body.signature,
        ]);
        const swapInput = enc('address,uint256,uint256,bytes,bool,uint256[]', [
          withFees
            ? '0x0000000000000000000000000000000000000002'
            : '0x0000000000000000000000000000000000000001',
          amount,
          withFees
            ? BigInt(body.quote.output.amount)
            : BigInt(body.quote.aggregatedOutputs[0].minAmount),
          `${tokenIn}000bb8${tokenOut.slice(2)}`,
          true,
          [],
        ]);
        const payments = withFees
          ? [
              enc('address,address,uint256', [tokenOut, recipients[0], 100n]),
              enc('address,address,uint256', [tokenOut, recipients[1], 1000000000000000000n / 99n]),
              enc('address,address,uint256', [
                tokenOut,
                '0x0000000000000000000000000000000000000001',
                BigInt(body.quote.aggregatedOutputs[0].minAmount),
              ]),
            ]
          : [];
        result = {
          requestId: 'local-build',
          swap: {
            chainId: 31337,
            from: signer,
            to: router,
            value: '0',
            data: encodeFunctionData({
              abi,
              functionName: 'execute',
              args: [
                withFees ? '0x0a00060704' : '0x0a00',
                [permitInput, swapInput, ...payments],
                BigInt(body.deadline),
              ],
            }),
          },
        };
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-universal-router-version': '2.1.2',
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      providerError = error;
      res.writeHead(500);
      res.end('{}');
    }
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(28547, '127.0.0.1', resolve);
  });
  async function start(execution = true) {
    let diagnostics = '';
    server = spawn(join(root, 'target/debug/honey-server'), [], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        HOST: '127.0.0.1',
        PORT: '28546',
        DATABASE_URL: `postgres://honey:honey_local_only@127.0.0.1:25432/${database}`,
        REDIS_URL: 'redis://127.0.0.1:26379',
        REDIS_NAMESPACE: `honey-rpc:${database.slice('honey_aave_smoke_'.length)}`,
        AUTH_ORIGIN: 'http://localhost:5173',
        AUTH_CHAIN_ID: '31337',
        MAX_REQUEST_BODY_BYTES: '196608',
        ...(execution ? { UNISWAP_EXECUTION_CONFIG_FILE: configFile } : {}),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    server.stderr.on('data', (b) => {
      diagnostics = (diagnostics + b.toString()).slice(-8192);
    });
    await poll(
      () => {
        assert.equal(server.exitCode, null, `server startup: ${diagnostics}`);
        return api.health().catch(() => null);
      },
      (v) => v !== null,
      20,
    );
  }
  await start();
  const configuration = await api.swapExecution();
  const challenge = await api.createSignInChallenge(signer, 'eip155:31337');
  const session = await api.verifySignIn(
    challenge.id,
    await signEvmMessage(key, challenge.message),
  );
  const token = session.accessToken;
  const feeBalances = await Promise.all(
    recipients.map((recipient) => read(tokenOut, abi, 'balanceOf', [recipient])),
  );
  const before = {
    input: await read(tokenIn, abi, 'balanceOf', [signer]),
    output: await read(tokenOut, abi, 'balanceOf', [signer]),
  };
  const intent = {
    tokenIn,
    tokenOut,
    amountRaw: amount.toString(),
    slippageBps: '100',
    minimumOutputRaw: '1',
    deadline: String(Math.floor(Date.now() / 1000) + 600),
    maximumNetworkFeeRaw: '10000000000000000',
  };
  const created = await api.createSwapOperation(token, 'fork-swap', intent);
  const id = created.operation.id;
  assert.equal((await api.createSwapOperation(token, 'fork-swap', intent)).operation.id, id);
  await poll(
    () => api.operation(token, id),
    (v) => v.operation.state === 'awaiting_permit',
  );
  console.error('HTTP swap: immutable review ready');
  const review = await api.swapReview(token, id);
  const context = { configuration, intent, signer, operationId: id, reviewHash: review.reviewHash };
  validateSwapReview(review, context);
  const signature = await signEvmTypedData(key, permit2TypedData(review.review.permit));
  const permit = {
    expectedVersion: review.operationVersion,
    reviewHash: review.reviewHash,
    signature,
  };
  await api.submitSwapPermit(token, id, permit);
  if (unfillable) {
    const failed = await poll(
      () => api.operation(token, id),
      (v) => v.operation.state === 'failed',
    );
    assert.equal(failed.preparation, null);
    assert.equal(failed.submission, null);
    assert.equal(await read(tokenIn, abi, 'balanceOf', [signer]), before.input);
    assert.equal(await read(tokenOut, abi, 'balanceOf', [signer]), before.output);
    assert.equal(await read(tokenIn, abi, 'allowance', [signer, permit2]), 0n);
    assert.equal(
      (await read(permit2, permitAbi, 'allowance', [signer, tokenIn, router]))[2],
      Number(review.review.permit.nonce),
    );
    assert.deepEqual(await api.swapReview(token, id), {
      ...review,
      operationVersion: failed.operation.version,
    });
    assert.equal(quoteCalls, 1);
    assert.equal(buildCalls, 1);
    console.log(
      JSON.stringify(
        {
          scope: 'Local actual-contract unfillable minimum; synthetic provider',
          forkBlock: { number: BigInt(fork.number).toString(), hash: fork.hash },
          operationId: id,
          finalState: failed.operation.state,
          preparation: null,
          submission: null,
          balancesUnchanged: true,
          permitNonceUnconsumed: true,
          erc20AllowanceUnchanged: true,
          reviewRetained: true,
          quoteCalls,
          buildCalls,
        },
        null,
        2,
      ),
    );
  } else {
    await poll(
      () => api.operation(token, id),
      (v) => v.operation.state === 'awaiting_signature',
    );
    console.error('HTTP swap: actual-contract preparation ready');
    const signing = await api.swapSigningRequest(token, id);
    validateSwapSigning(signing, context, signature);
    assert.equal(signing.prepared.plan.steps.length, 2);
    await stop();
    await start();
    assert.deepEqual(await api.swapSigningRequest(token, id), signing);
    assert.deepEqual((await api.swapIntent(token, id)).intent, intent);
    await api.submitSwapPermit(token, id, permit);
    const signedTransactions = [];
    for (const tx of swapTransactionRequests(signing))
      signedTransactions.push(await signEvmTransaction(key, tx));
    const payload = {
      expectedVersion: signing.operationVersion,
      planHash: signing.planHash,
      signedTransactions,
    };
    const staged = await api.submitSwap(token, id, payload);
    assert.deepEqual(staged.submission.transactionHashes, signedTransactions.map(keccak256));
    await stop();
    await start();
    assert.deepEqual((await api.submitSwap(token, id, payload)).submission, staged.submission);
    console.error('HTTP swap: encrypted submission recovered after restart');
    await poll(
      () => api.operation(token, id),
      (v) => v.reconciliation?.transactions.every((t) => t.inclusion?.succeeded),
    );
    const head = await rpc('eth_getBlockByNumber', ['latest', false]);
    const finalized = await rpc('eth_getBlockByNumber', ['finalized', false]);
    const lag = BigInt(head.number) - BigInt(finalized.number);
    assert.ok(lag >= 0n && lag <= 256n);
    await rpc('anvil_mine', [`0x${lag.toString(16)}`, '0x0']);
    const settled = await poll(
      () => api.operation(token, id),
      (v) => v.operation.state === 'succeeded',
    );
    const spent = before.input - (await read(tokenIn, abi, 'balanceOf', [signer]));
    const received = (await read(tokenOut, abi, 'balanceOf', [signer])) - before.output;
    assert.equal(spent, amount);
    assert.ok(received >= BigInt(review.review.authority.minimumOutputRaw));
    assert.equal(await read(tokenIn, abi, 'allowance', [signer, permit2]), 0n);
    const allowance = await read(permit2, permitAbi, 'allowance', [signer, tokenIn, router]);
    assert.equal(allowance[0], 0n);
    assert.equal(allowance[2], Number(review.review.permit.nonce) + 1);
    assert.equal(quoteCalls, 1);
    assert.equal(buildCalls, 1);
    const feeAmounts = await Promise.all(
      recipients.map(
        async (recipient, i) =>
          (await read(tokenOut, abi, 'balanceOf', [recipient])) - feeBalances[i],
      ),
    );
    const gross = received + feeAmounts.reduce((a, b) => a + b, 0n);
    assert.equal(gross, BigInt(quoteResponse.quote.output.amount));
    for (const fee of feeAmounts) {
      if (withFees) {
        assert.ok(fee > 0n);
        assert.ok(fee <= gross / 100n + 1n);
      } else assert.equal(fee, 0n);
    }
    if (dropAck) {
      assert.equal(lostAcknowledgement, staged.submission.transactionHashes[0]);
      assert.deepEqual(
        broadcasts,
        staged.submission.transactionHashes,
        'each signed transaction is broadcast exactly once despite lost acknowledgement',
      );
    }
    for (const asset of [tokenIn, tokenOut])
      assert.equal(await read(asset, abi, 'balanceOf', [router]), 0n);
    await stop();
    await start(false);
    assert.equal((await api.operation(token, id)).operation.state, 'succeeded');
    console.log(
      JSON.stringify(
        {
          scope:
            'Local chain31337 actual-contract HTTP/worker lifecycle; synthetic provider; simulated finality; no production acceptance',
          forkBlock: { number: BigInt(fork.number).toString(), hash: fork.hash },
          registry,
          operationId: id,
          planHash: signing.planHash,
          reviewHash: review.reviewHash,
          transactionHashes: staged.submission.transactionHashes,
          spentRaw: spent.toString(),
          receivedRaw: received.toString(),
          minimumOutputRaw: review.review.authority.minimumOutputRaw,
          simulatedFinalityBlocks: lag.toString(),
          quoteCalls,
          buildCalls,
          feeAmountsRaw: feeAmounts.map(String),
          lostAcknowledgement,
          broadcasts,
          finalState: settled.operation.state,
          permitNonceConsumed: true,
          finiteAllowancesConsumed: true,
          signingRestartRecovered: true,
          submissionRestartRecovered: true,
          historyWithExecutionDisabled: true,
        },
        null,
        2,
      ),
    );
  }
} finally {
  key.fill(0);
  await stop();
  if (provider) await new Promise((r) => provider.close(r));
  if (rpcProxy) await new Promise((r) => rpcProxy.close(r));
  try {
    if (database)
      databaseCommand({
        command: 'drop_database',
        database,
        cleanupRpcBudget: true,
        cleanupUniswapBudget: true,
      });
  } finally {
    assert.equal(await rpc('evm_revert', [snapshot]), true);
    await rm(dir, { recursive: true, force: true });
  }
  console.error('Owned database removed, fork snapshot restored, public key buffer wiped.');
}
