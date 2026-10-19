"""Independent public vectors: Python SHA256/Edwards arithmetic and OpenSSL Ed25519.
No Honey/Solana Rust or JavaScript implementation is imported. Never use these keys.
"""
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
P = 2**255 - 19
D = (-121665 * pow(121666, -1, P)) % P


def on_curve(encoded):
    y = int.from_bytes(encoded, "little") & ((1 << 255) - 1)
    x2 = ((y*y - 1) * pow(D*y*y + 1, -1, P)) % P
    return x2 == 0 or pow(x2, (P-1)//2, P) == 1


def pda(program, seeds):
    for bump in range(255, -1, -1):
        candidate = hashlib.sha256(b"".join(seeds) + bytes([bump]) + program + b"ProgramDerivedAddress").digest()
        if not on_curve(candidate):
            return candidate, bump
    raise AssertionError("no PDA bump")


with tempfile.TemporaryDirectory(prefix="honey-solana-public-vectors-") as folder:
    work = Path(folder)

    def key_file(n):
        path = work / f"fixture-{n}.der"
        path.write_bytes(bytes.fromhex("302e020100300506032b657004220420") + bytes([n])*32)
        return path

    def public(n):
        out = subprocess.check_output(["openssl", "pkey", "-inform", "DER", "-in", str(key_file(n)), "-pubout", "-outform", "DER"])
        assert out[:12] == bytes.fromhex("302a300506032b6570032100")
        return out[12:]

    keys = {n: public(n) for n in [1,2,3,4,5,6,240,242]}
    roots = {n: hashlib.sha256(k).digest() for n,k in keys.items()}
    program, identity, network = keys[240], keys[1], bytes([7])*32
    wallet, bump = pda(program, [b"wallet-v1", identity, struct.pack("<I",7)])

    def vector(name, signer, data, action_keys):
        message = hashlib.sha256(b"HoneyBunkSolanaV1" + program + wallet + network + struct.pack("<I",len(data))
                                 + data + struct.pack("<H",len(action_keys)) + b"".join(action_keys)).digest()
        path = work / "public-message.bin"
        path.write_bytes(message)
        signature = subprocess.check_output(["openssl","pkeyutl","-sign","-rawin","-keyform","DER",
                                            "-inkey",str(key_file(signer)),"-in",str(path)])
        proof = bytes([1,0]) + struct.pack("<7H",48,65535,16,65535,112,32,65535) + keys[signer] + signature + message
        assert len(proof) == 144
        return {"name":name,"instruction":data.hex(),"actionKeys":[k.hex() for k in action_keys],
                "digest":message.hex(),"precompile":proof.hex()}

    init = bytes([0]) + network + identity + struct.pack("<I",7) + roots[2] + roots[3]
    execute = bytes([1]) + struct.pack("<IIQQQ",0,0,0,0,100) + roots[4] + bytes([0]) + struct.pack("<Q",1000000)
    recover = bytes([2]) + struct.pack("<I",0) + roots[5] + roots[6]
    state = b"HNYBUNK1" + network + identity + struct.pack("<IIIQ",7,0,0,0) + roots[2] + roots[3] + bytes([bump])
    assert len(state) == 157
    result = {"warning":"Public deterministic fixture keys only; never use for funds.", "program":program.hex(),
              "wallet":wallet.hex(),"bump":bump,"state":state.hex(),"network":network.hex(),
              "spentOwner":pda(program,[b"spent-v1",wallet,roots[2]])[0].hex(),
              "vectors":[vector("initialize",1,init,[]),vector("native",2,execute,[keys[242]]),vector("recover",3,recover,[])]}
    target = ROOT / "tests/fixtures/v1.json"
    if "--check" in sys.argv:
        assert json.loads(target.read_text()) == result, "independent vectors changed"
        print("Three independent Solana vectors match")
    else:
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text(json.dumps(result,indent=2)+"\n")
