#!/usr/bin/env python3
"""Disposable real-Geth/Alto acceptance run. No public RPCs or funded keys."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
GETH = 'ethereum/client-go@sha256:abf3605177f8bdcfce436985a8054cca4ae59256323a4ffb72c56c04f3d1fadd'
NODE = 'node@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752'


def command(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def rpc(url, method):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': []}).encode()
    with urllib.request.urlopen(urllib.request.Request(url, body, {'Content-Type': 'application/json'}), timeout=5) as response:
        data = json.load(response)
    if 'error' in data:
        raise RuntimeError(data['error'])
    return data['result']


def wait_ready(container, url, method):
    for _ in range(90):
        if command('docker', 'inspect', '--format', '{{.State.Running}}', container) != 'true':
            raise RuntimeError(f'{container} stopped before readiness')
        try:
            result = rpc(url, method)
            if result and result != '0x0':
                return result
        except (OSError, ValueError, RuntimeError):
            pass
        time.sleep(0.5)
    raise RuntimeError(f'{container} readiness timed out')


def port(container, internal):
    value = command('docker', 'port', container, str(internal))
    if not value.startswith('127.0.0.1:'):
        raise RuntimeError(f'non-loopback port: {value}')
    return f'http://{value}'


def source_hashes():
    keyring = ROOT.parent.parent / 'packages/keyring'
    paths = (list((ROOT / 'src').glob('*.sol')) + list(HERE.glob('*.mjs')) +
             list(HERE.glob('*.py')) + list((ROOT / 'test/recovery').glob('*.sol')) +
             list((keyring / 'src').glob('*.ts')) + list((keyring / 'src/fixtures').glob('bunk*.json')) +
             list((keyring / 'scripts').glob('bunk*.py')) +
             list((keyring / 'tests').glob('**/bunk*.mjs')) +
             [HERE / 'pnpm-lock.yaml', ROOT / 'foundry.toml', ROOT / 'dependencies.lock.json',
              ROOT / 'test/BundlerNegativeAccount.sol', ROOT / 'test/BunkRecoveryIntegration.t.sol',
              ROOT / 'test/BunkSeedRecoveryIntegration.t.sol',
              ROOT / 'test/BunkIntegration.t.sol', keyring / 'package.json', keyring / 'vitest.config.ts',
              ROOT.parent.parent / 'pnpm-lock.yaml'])
    return {os.path.relpath(p, ROOT): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths)}


def artifact_hashes():
    return {os.path.relpath(p, ROOT): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted((ROOT / 'out').glob('**/*.json'))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='Write successful evidence JSON here.')
    args = parser.parse_args()
    if not (HERE / 'node_modules/@pimlico/alto/esm/cli/alto.js').exists():
        raise RuntimeError('Run pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts in this folder first.')
    if not (ROOT / 'out/BundlerNegativeAccount.sol/BundlerNegativeAccount.json').exists():
        raise RuntimeError('Run forge build in packages/bunk-evm first.')
    sources_before, artifacts_before = source_hashes(), artifact_hashes()
    work = Path(tempfile.mkdtemp(prefix='honey-bunk-acceptance-'))
    name = f'honey-bunk-{uuid.uuid4().hex[:10]}'
    geth, alto = name + '-geth', name + '-alto'
    created = []
    network_created = False
    try:
        # Export the pinned client's complete genesis so required system code is preserved.
        genesis = json.loads(command('docker', 'run', '--rm', GETH, '--dev', 'dumpgenesis'))
        # Explicit Osaka test. The default Bogota dev fork is a separate, failing case.
        genesis['config'].pop('bogotaTime', None)
        genesis['config'].pop('amsterdamTime', None)
        genesis['gasLimit'] = hex(30_000_000)
        for address in ['7e5f4552091a69125d5dfcb7b8c2659029395bdf', '2b5ad5c4795c026514f8317c7a215e218dccd6cf']:
            genesis['alloc'][address] = {'balance': hex(1000 * 10**18)}
        (work / 'genesis.json').write_text(json.dumps(genesis, indent=2) + '\n')
        command('docker', 'network', 'create', name)
        network_created = True
        command('docker', 'run', '--detach', '--name', geth, '--network', name,
                '--network-alias', 'geth', '--label', 'honey.task=TASK-0089',
                '-p', '127.0.0.1::8545', '--tmpfs', '/data', '--entrypoint', '/bin/sh',
                '--mount', f'type=bind,source={work}/genesis.json,target=/genesis.json,readonly', GETH,
                '-c', 'geth --datadir /data init /genesis.json && exec geth --datadir /data --dev --dev.period 1 '
                '--http --http.addr 0.0.0.0 --http.api eth,net,web3,debug '
                '--http.vhosts localhost,127.0.0.1,geth --ipcdisable --nodiscover --maxpeers 0 --verbosity 2')
        created.append(geth)
        node_rpc = port(geth, 8545)
        wait_ready(geth, node_rpc, 'eth_blockNumber')
        if rpc(node_rpc, 'eth_chainId') != '0x539':
            raise RuntimeError('Unexpected local chain ID')
        env = dict(os.environ, BUNK_TEST_RPC=node_rpc)
        subprocess.run(['node', str(HERE / 'deploy.mjs')], cwd=work, env=env, check=True, timeout=180)
        state = json.loads((work / 'state.json').read_text())
        command('docker', 'run', '--detach', '--name', alto, '--network', name,
                '--label', 'honey.task=TASK-0089', '-p', '127.0.0.1::3000',
                '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL',
                '--security-opt', 'no-new-privileges', '--workdir', '/app',
                '--mount', f'type=bind,source={HERE},target=/app,readonly', NODE,
                'node', 'node_modules/@pimlico/alto/esm/cli/alto.js', 'run',
                '--entrypoints', state['entryPoint'],
                '--executor-private-keys', '0x' + '0'*63 + '2',
                '--rpc-url', 'http://geth:8545', '--safe-mode', 'true',
                '--dangerous-skip-user-operation-validation', 'false',
                '--expiration-check', 'true', '--refilling-wallets', 'false',
                '--utility-wallet-monitor', 'false', '--deploy-simulations-contract', 'false',
                '--entrypoint-simulation-contract-v7', state['epSimulation'],
                '--supports-eip7623', 'true', '--port', '3000', '--log-level', 'debug')
        created.append(alto)
        bundler_rpc = port(alto, 3000)
        wait_ready(alto, bundler_rpc, 'eth_supportedEntryPoints')
        env['BUNK_BUNDLER_RPC'] = bundler_rpc
        subprocess.run(['node', '--import', str(HERE / 'typescript-loader.mjs'), str(HERE / 'validate.mjs')], cwd=work, env=env, check=True, timeout=360)
        subprocess.run(['node', str(HERE / 'recovery.mjs')], cwd=work, env=env, check=True, timeout=120)
        subprocess.run(['node', str(HERE / 'safe-recovery.mjs')], cwd=work, env=env, check=True, timeout=180)
        subprocess.run(['node', '--import', str(HERE / 'typescript-loader.mjs'), str(HERE / 'client-v2.mjs')], cwd=work, env=env, check=True, timeout=300)
        subprocess.run(['node', str(HERE / 'seed-recovery.mjs')], cwd=work, env=env, check=True, timeout=240)
        subprocess.run(['node', '--import', str(HERE / 'typescript-loader.mjs'), str(HERE / 'client-v3.mjs')], cwd=work, env=env, check=True, timeout=300)
        subprocess.run(['node', '--import', str(HERE / 'typescript-loader.mjs'), str(HERE / 'coordinator-v3.mjs')], cwd=work, env=env, check=True, timeout=300)
        report = json.loads((work / 'results.json').read_text())
        report['experimentalRecovery'] = json.loads((work / 'recovery-results.json').read_text())
        report['safeRecoveryV2'] = json.loads((work / 'safe-recovery-results.json').read_text())
        report['clientV2'] = json.loads((work / 'client-v2-results.json').read_text())
        report['seedRecoveryV3'] = json.loads((work / 'seed-recovery-results.json').read_text())
        report['clientV3'] = json.loads((work / 'client-v3-results.json').read_text())
        report['coordinatorV3'] = json.loads((work / 'coordinator-v3-results.json').read_text())
        report.update({
            'scope': 'Local isolated Osaka chain, unmodified Alto 0.0.18; not public-chain or current-provider certification.',
            'gethImage': GETH, 'nodeImage': NODE, 'altoVersion': '0.0.18',
            'clientVersion': rpc(node_rpc, 'web3_clientVersion'),
            'genesisConfig': genesis['config'],
            'factoryStakeWei': str(10**18), 'paymasterStakeWei': str(10**18),
            'unstakeDelaySeconds': 86400,
            'sourcesSha256': sources_before,
            'artifactsSha256': artifacts_before,
            'sourceAndArtifactHashesRechecked': True,
        })
        if source_hashes() != sources_before or artifact_hashes() != artifacts_before:
            raise RuntimeError('Test sources or compiled artifacts changed during acceptance; evidence not published.')
        output = args.output or work / 'evidence.json'
        output.write_text(json.dumps(report, indent=2) + '\n')
        print(f'Evidence: {output}', flush=True)
    finally:
        for container in reversed(created):
            with (work / f'{container}.log').open('w') as log:
                subprocess.run(['docker', 'logs', container], stdout=log, stderr=subprocess.STDOUT, check=False)
            subprocess.run(['docker', 'rm', '--force', container], stdout=subprocess.DEVNULL, check=False)
        if network_created:
            subprocess.run(['docker', 'network', 'rm', name], stdout=subprocess.DEVNULL, check=False)
        print(f'Test logs retained in {work}', flush=True)


if __name__ == '__main__':
    main()
