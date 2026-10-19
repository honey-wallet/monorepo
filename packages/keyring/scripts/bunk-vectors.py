"""Independent Bunk v1 test-only fixture oracle; never use with a real recovery phrase.

Uses Python HMAC/PBKDF2, cryptography's OpenSSL curve implementation, and Foundry
cast's local keccak command. No network requests; no Honey/Noble/Scure imports.
Run: python3 packages/keyring/scripts/bunk-vectors.py --check
Regenerate intentionally: python3 packages/keyring/scripts/bunk-vectors.py --write
"""

import argparse
import hashlib
import hmac
import json
import pathlib
import subprocess

from cryptography.hazmat.primitives.asymmetric import ec, ed25519
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

# This deterministic phrase is generated solely for public test vectors. It and
# every derived account are compromised by design and must never hold funds.
PHRASE = 'push protect grunt rookie audit pave detect swamp clerk document april venue'
SEED = hashlib.pbkdf2_hmac("sha512", PHRASE.encode(), b"mnemonic", 2048)
ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
TARGET = pathlib.Path(__file__).resolve().parents[1] / "src/fixtures/bunk-v1.json"


def base58(raw):
    number = int.from_bytes(raw, "big")
    out = ""
    while number:
        number, digit = divmod(number, 58)
        out = BASE58[digit] + out
    return "1" * (len(raw) - len(raw.lstrip(b"\x00"))) + out


def keccak(raw):
    return bytes.fromhex(subprocess.check_output(
        ["cast", "keccak", "0x" + raw.hex()], text=True
    ).strip().removeprefix("0x"))


def derive(coin, network_id, account, owner):
    parts = [7744, 1, coin]
    parts += [(network_id >> (31 * i)) & 0x7FFFFFFF for i in range(8, -1, -1)]
    parts += [account, owner]
    node = hmac.digest(b"ed25519 seed" if coin == 501 else b"Bitcoin seed", SEED, "sha512")
    for index in parts:
        child = hmac.digest(node[32:], b"\x00" + node[:32] + (index + 2**31).to_bytes(4, "big"), "sha512")
        if coin == 501:
            node = child
        else:
            tweak = int.from_bytes(child[:32], "big")
            key = (int.from_bytes(node[:32], "big") + tweak) % ORDER
            assert tweak < ORDER and key != 0, "fixture hits BIP32 invalid-child case"
            node = key.to_bytes(32, "big") + child[32:]
    return "m/" + "/".join(f"{i}'" for i in parts), node[:32]


def fixture(name, network, coin, network_id, account=0, owner=0):
    path, private = derive(coin, network_id, account, owner)
    if coin == 501:
        public = ed25519.Ed25519PrivateKey.from_private_bytes(private).public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        commitment = hashlib.sha256(public).digest()
    else:
        point = ec.derive_private_key(int.from_bytes(private, "big"), ec.SECP256K1()).public_key()
        public = point.public_bytes(Encoding.X962, PublicFormat.CompressedPoint)
        if coin == 60:
            address = keccak(point.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)[1:])[-20:]
            commitment = keccak(address)
        else:
            commitment = hashlib.new("ripemd160", hashlib.sha256(public).digest()).digest()
    return dict(name=name, network=network, accountIndex=account, ownerIndex=owner,
                path=path, publicKey="0x" + public.hex(),
                commitment="0x" + commitment.hex())


genesis = bytes(range(32))  # synthetic network identity, not a cluster claim
vectors = [
    fixture("evm-ethereum-first", dict(family="evm", chainId="1"), 60, 1),
    fixture("evm-ethereum-next", dict(family="evm", chainId="1"), 60, 1, owner=1),
    fixture("evm-base-first", dict(family="evm", chainId="8453"), 60, 8453),
    fixture("evm-max-chain-id", dict(family="evm", chainId=str(2**256-1)), 60, 2**256-1, account=7),
    fixture("evm-last-owner", dict(family="evm", chainId="1"), 60, 1, owner=2**31-1),
    fixture("solana-synthetic-first", dict(family="solana", genesisHash=base58(genesis)), 501, int.from_bytes(genesis, "big")),
    fixture("solana-synthetic-next", dict(family="solana", genesisHash=base58(genesis)), 501, int.from_bytes(genesis, "big"), owner=1),
    *[fixture(f"bitcoin-{name}", dict(family="bitcoin", network=name), 0, i)
      for i, name in enumerate(["mainnet", "testnet", "signet", "regtest"])],
]
serialized = json.dumps(dict(
    derivationVersion=1,
    purpose="synthetic-test-only-never-fund",
    phrase=PHRASE,
    vectors=vectors,
), indent=2) + "\n"
parser = argparse.ArgumentParser(description=__doc__)
mode = parser.add_mutually_exclusive_group(required=True)
mode.add_argument("--check", action="store_true")
mode.add_argument("--write", action="store_true")
args = parser.parse_args()
if args.write:
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    TARGET.write_text(serialized)
    print(f"Wrote {len(vectors)} public test-phrase vectors")
else:
    assert json.loads(TARGET.read_text()) == json.loads(serialized), "Bunk v1 vector mismatch"
    print(f"Independent oracle verified {len(vectors)} Bunk v1 vectors")
