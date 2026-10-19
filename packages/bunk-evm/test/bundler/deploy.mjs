import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, http, parseEther, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { pimlicoEntrypointSimulationsV7DeployBytecode } from './node_modules/@pimlico/alto/esm/types/index.js';

process.on('uncaughtException', (e) => {
  console.error(e.shortMessage, e.details, e.cause?.details);
  process.exit(1);
});
const root = fileURLToPath(new URL('../../', import.meta.url));
const rpc = process.env.BUNK_TEST_RPC;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(rpc ?? '')) throw Error('local test RPC required');
const chain = defineChain({
  id: 1337,
  name: 'Bunk isolated Geth',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
});
const client = createPublicClient({ chain, transport: http(rpc), pollingInterval: 300 });
const admin = privateKeyToAccount(toHex(1n, { size: 32 }));
const sponsor = privateKeyToAccount(toHex(4n, { size: 32 }));
const wallet = createWalletClient({ account: admin, chain, transport: http(rpc) });
const artifact = (folder, name) =>
  JSON.parse(fs.readFileSync(`${folder}/${name}.sol/${name}.json`));
const local = (name) => artifact(`${root}/out`, name);
async function deploy(a, args = []) {
  const hash = await wallet.deployContract({
    abi: a.abi,
    bytecode: a.bytecode.object,
    args,
    gas: 8000000n,
  });
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw Error('deploy failed');
  console.log('deployed', r.contractAddress);
  return r.contractAddress;
}
async function write(name, address, functionName, args = [], value = 0n) {
  const hash = await wallet.writeContract({
    address,
    abi: local(name).abi,
    functionName,
    args,
    value,
    gas: 1000000n,
  });
  const r = await client.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw Error(`${functionName} failed`);
}
const entryPoint = await deploy(local('EntryPoint'));
const singleton = await deploy(local('Safe'));
const proxyFactory = await deploy(local('SafeProxyFactory'));
const factory = await deploy(local('BunkFactory'), [
  singleton,
  proxyFactory,
  entryPoint,
  admin.address,
]);
const module = await client.readContract({
  address: factory,
  abi: local('BunkFactory').abi,
  functionName: 'module',
});
const paymaster = await deploy(local('BunkPaymaster'), [
  entryPoint,
  module,
  sponsor.address,
  parseEther('0.1'),
  admin.address,
]);
await write('BunkFactory', factory, 'addStake', [86400], parseEther('1'));
await write('BunkPaymaster', paymaster, 'addStake', [86400], parseEther('1'));
await write('BunkPaymaster', paymaster, 'deposit', [], parseEther('5'));
await write('BunkPaymaster', paymaster, 'setBudget', [parseEther('5')]);
const target = await deploy(
  JSON.parse(fs.readFileSync(`${root}/out/BunkIntegration.t.sol/Target.json`)),
);
const epSimulation = await deploy({
  abi: [],
  bytecode: { object: pimlicoEntrypointSimulationsV7DeployBytecode },
});
const badAccount = await deploy(local('BundlerNegativeAccount'), [entryPoint]);
await write('EntryPoint', entryPoint, 'depositTo', [badAccount], parseEther('1'));
const unstakedFactory = await deploy(local('BunkFactory'), [
  singleton,
  proxyFactory,
  entryPoint,
  admin.address,
]);
const unstakedModule = await client.readContract({
  address: unstakedFactory,
  abi: local('BunkFactory').abi,
  functionName: 'module',
});
const unstakedPaymaster = await deploy(local('BunkPaymaster'), [
  entryPoint,
  unstakedModule,
  sponsor.address,
  parseEther('0.1'),
  admin.address,
]);
await write('BunkPaymaster', unstakedPaymaster, 'addStake', [86400], parseEther('1'));
await write('BunkPaymaster', unstakedPaymaster, 'deposit', [], parseEther('5'));
await write('BunkPaymaster', unstakedPaymaster, 'setBudget', [parseEther('5')]);
const state = {
  rpc,
  entryPoint,
  singleton,
  proxyFactory,
  factory,
  module,
  paymaster,
  target,
  epSimulation,
  badAccount,
  unstakedFactory,
  unstakedModule,
  unstakedPaymaster,
};
fs.writeFileSync('state.json', `${JSON.stringify(state, null, 2)}\n`);
console.log('Local contracts and stake configured.');
