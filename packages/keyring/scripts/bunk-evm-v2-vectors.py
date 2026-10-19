"""Independent v2 test oracle: Python/OpenSSL BIP32 and Foundry hashes/ABI/ECDSA.
Public synthetic fixture only. No Honey TypeScript, Noble, Scure or viem imports.
"""
import argparse
import importlib.util
import json
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('v1_oracle', HERE / 'bunk-evm-vectors.py')
v1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v1)
kh, hx, raw, word, aw, abi, cast = v1.kh, v1.hx, v1.raw, v1.word, v1.address_word, v1.abi, v1.cast
TARGET = HERE.parent / 'src/fixtures/bunk-evm-v2.json'

def typed(name, chain, contract, struct):
    domain = kh(kh(b'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)') + kh(name.encode()) + kh(b'2') + word(chain) + aw(contract))
    return kh(b'\x19\x01' + domain + kh(struct))

def descriptor(parts):
    path, key = v1.derive_parts(parts)
    address = v1.address(key)
    pub = ec.derive_private_key(int.from_bytes(key, 'big'), ec.SECP256K1()).public_key().public_bytes(Encoding.X962, PublicFormat.CompressedPoint)
    return {'path': path, 'publicKey': hx(pub), 'address': address, 'commitment': hx(kh(raw(address)))}, key

def fixture():
    # Same synthetic dependencies as v1; versioning alone must change identity/account/digests.
    baseline = json.loads((HERE.parent / 'src/fixtures/bunk-evm-v1.json').read_text())
    c, initializer, config_hash = baseline['config'], raw(baseline['initializer']), raw(baseline['configHash'])
    cert_type = b'BunkOwnerIntent(address entryPoint,address account,uint256 nonce,bytes32 callDataHash,bytes32 accountGasLimits,uint256 preVerificationGas,uint128 maxGasCost,address paymaster,uint32 ownerIndex,bytes32 nextCommitment,bytes32 envelopeRoot,uint48 validAfter,uint48 executeUntil)'
    vectors = []
    for chain, account, index, attempt in [(1, 0, 0, 0), (8453, 0, 3, 254), (1, 7, 2, 255)]:
        suffix = [60] + [(chain >> (31 * i)) & 0x7fffffff for i in range(8, -1, -1)] + [account, index]
        owner, owner_key = descriptor([7744, 2, 0] + suffix)
        successor, _ = descriptor([7744, 2, 0] + suffix[:-1] + [index + 1])
        initial, _ = descriptor([7744, 2, 0] + suffix[:-1] + [0])
        identity, identity_key = descriptor([7744, 2, 2, 60, account])
        leaves, signers, selected_key = [], [], None
        for leaf in range(256):
            signer, key = descriptor([7744, 2, 1] + suffix + [leaf])
            signers.append(signer)
            leaves.append(kh(kh(word(leaf) + aw(signer['address']))))
            if leaf == attempt: selected_key = key
        levels = [leaves]
        while len(levels[-1]) > 1:
            previous = levels[-1]
            levels.append([kh(b''.join(sorted(previous[i:i+2]))) for i in range(0, len(previous), 2)])
        proof = [hx(level[(attempt >> depth) ^ 1]) for depth, level in enumerate(levels[:-1])]
        root = levels[-1][0]
        nonce = kh(abi('string,address,uint32', 'HoneyBunkAccountV2', identity['address'], account))
        salt = kh(kh(initializer) + nonce)
        init_hash = kh(raw(c['proxyCreationCode']) + aw(c['singleton']['address']))
        safe = hx(kh(b'\xff' + raw(c['proxyFactory']['address']) + salt + init_hash)[-20:])
        deployment_digest = typed('HoneyBunkDeployment', chain, c['factory']['address'], kh(b'BunkDeployment(address identity,uint32 accountIndex,address account,bytes32 commitment,bytes32 configHash)') + aw(identity['address']) + word(account) + aw(safe) + raw(initial['commitment']) + config_hash)
        deployment_sig = v1.signed(identity_key, deployment_digest)
        factory_data = cast('calldata', 'deploy(address,uint32,bytes32,bytes)', identity['address'], account, initial['commitment'], deployment_sig)
        calls = raw(cast('sig', 'executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)')) + abi('(address,uint256,bytes)[]', f'[(0x{"77"*20},0,{cast("calldata", "set(uint256)", 42)})]')
        gas = word((500000 << 128) | 500000)
        certificate = {'entryPoint': c['entryPoint']['address'], 'account': safe, 'nonce': str(index), 'callDataHash': hx(kh(calls)), 'accountGasLimits': hx(gas), 'preVerificationGas': '100000', 'maxGasCost': '11000000000000000', 'paymaster': '0x'+'00'*20, 'ownerIndex': index, 'nextCommitment': successor['commitment'], 'envelopeRoot': hx(root), 'validAfter': 1000, 'executeUntil': 2000}
        cert_words = aw(certificate['entryPoint']) + aw(safe) + word(index) + kh(calls) + gas + word(100000) + word(11000000000000000) + aw(certificate['paymaster']) + word(index) + raw(successor['commitment']) + root + word(1000) + word(2000)
        digest = typed('HoneyBunkOwner', chain, c['module']['address'], kh(cert_type) + cert_words)
        owner_sig = v1.signed(owner_key, digest)
        recovery = attempt == 255
        operation_calls = calls[:4] + abi('(address,uint256,bytes)[]', '[]') if recovery else calls
        init_code = raw(c['factory']['address']) + raw(factory_data) if index == 0 else b''
        priority, fee = (10000000000, 10000000000) if recovery else (1000000000, 2000000000)
        fees = word((priority << 128) | fee)
        inner = kh(aw(safe) + word(index) + kh(init_code) + kh(operation_calls) + gas + word(100000) + fees + kh(b''))
        userop = kh(inner + aw(c['entryPoint']['address']) + word(chain))
        envelope_sig = v1.signed(selected_key, userop)
        cert_tuple = '(' + ','.join(str(x) for x in certificate.values()) + ')'
        auth = abi('((address,address,uint256,bytes32,bytes32,uint256,uint128,address,uint32,bytes32,bytes32,uint48,uint48),uint8,bytes32[],bytes,bytes)', '('+cert_tuple+','+str(attempt)+',['+','.join(proof)+'],'+owner_sig+','+envelope_sig+')')
        assert len(auth) == 1120
        vectors.append({'chainId':str(chain), 'accountIndex':account, 'ownerIndex':index, 'attempt':attempt, 'identity':identity, 'owner':owner, 'successor':successor, 'initial':initial, 'envelope':signers[attempt], 'envelopeAddresses':[s['address'] for s in signers], 'proof':proof, 'account':safe, 'deploymentDigest':hx(deployment_digest), 'deploymentSignature':deployment_sig, 'factoryData':factory_data, 'callData':hx(calls), 'certificate':certificate, 'intentDigest':hx(digest), 'ownerSignature':owner_sig, 'operation':{'sender':safe,'nonce':str(index),'initCode':hx(init_code),'callData':hx(operation_calls),'verificationGasLimit':'500000','callGasLimit':'500000','preVerificationGas':'100000','maxPriorityFeePerGas':str(priority),'maxFeePerGas':str(fee),'paymasterAndData':'0x'}, 'userOpHash':hx(userop), 'envelopeSignature':envelope_sig, 'authorization':hx(auth)})
    return {'derivationVersion':2, 'phrase':v1.PHRASE, 'fixtureOnly':baseline['fixtureOnly'], 'config':c, 'vectors':vectors}

if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--write',action='store_true');parser.add_argument('--check',action='store_true');args=parser.parse_args()
    result=fixture()
    if args.write: TARGET.write_text(json.dumps(result,indent=2)+'\n');print('Wrote',TARGET)
    else:
        assert json.loads(TARGET.read_text()) == result, 'Bunk v2 oracle mismatch'
        print('Independent Bunk v2 oracle: 3 vectors match')
