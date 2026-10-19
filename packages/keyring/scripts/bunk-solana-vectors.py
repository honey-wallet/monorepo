"""Independent PUBLIC phrase vectors: Python SLIP-10/PDA/encoding + OpenSSL Ed25519.
Never use these keys for funds. No Honey, Solana SDK or JS implementation imports.
"""
import hashlib
import hmac
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
SEED = hashlib.pbkdf2_hmac("sha512", PHRASE.encode(), b"mnemonic", 2048, 64)
TARGET = Path(__file__).resolve().parents[1]/"src/fixtures/bunk-solana.json"


def b58(value):
    n, out = int.from_bytes(value, "big"), ""
    while n:
        n, digit = divmod(n, 58)
        out = ALPHABET[digit]+out
    return "1"*(len(value)-len(value.lstrip(b"\0")))+out


def pda(program, seeds):
    prime = 2**255-19
    d = -121665*pow(121666, -1, prime) % prime
    for bump in range(255, -1, -1):
        value = hashlib.sha256(b"".join(seeds)+bytes([bump])+program+b"ProgramDerivedAddress").digest()
        y = int.from_bytes(value, "little") & ((1 << 255)-1)
        x2 = (y*y-1)*pow(d*y*y+1, -1, prime) % prime
        if x2 != 0 and pow(x2, (prime-1)//2, prime) != 1:
            return value, bump
    raise AssertionError("no bump")


def digits(value):
    n = int.from_bytes(value, "big")
    return [(n >> (31*i)) & 0x7fffffff for i in range(8, -1, -1)]


def main():
    with tempfile.TemporaryDirectory(prefix="honey-solana-phrase-vectors-") as directory:
        work = Path(directory)

        def keyfile(secret):
            file = work/"public-fixture.der"
            file.write_bytes(bytes.fromhex("302e020100300506032b657004220420")+secret)
            return str(file)

        def public(secret):
            data = subprocess.check_output(["openssl","pkey","-inform","DER","-in",keyfile(secret),"-pubout","-outform","DER"])
            assert data[:12] == bytes.fromhex("302a300506032b6570032100")
            return data[12:]

        def sign(secret, message):
            file = work/"public-message.bin"
            file.write_bytes(message)
            return subprocess.check_output(["openssl","pkeyutl","-sign","-rawin","-keyform","DER","-inkey",keyfile(secret),"-in",str(file)])

        result = []
        for network, program_seed, account_index in [(bytes([7])*32,240,7), (bytes([8])*32,240,7), (bytes([7])*32,239,7), (bytes([255])*32,240,0x7fffffff)]:
            program = public(bytes([program_seed])*32)
            keys = {}
            secrets = {}
            for name, role, epoch, owner_index in [("deployment",2,None,None), ("owner0",0,0,0), ("owner1",0,0,1), ("recovery0",3,0,None), ("nextOwner",0,1,0), ("nextRecovery",3,1,None), ("maxOwner",0,0x7fffffff,0x7fffffff)]:
                path = [7744,2,role,501]+digits(network)+digits(program)+[account_index]
                if epoch is not None:
                    path.append(epoch)
                if owner_index is not None:
                    path.append(owner_index)
                node = hmac.digest(b"ed25519 seed",SEED,"sha512")
                for part in path:
                    node = hmac.digest(node[32:], b"\0"+node[:32]+struct.pack(">I",part+0x80000000), "sha512")
                secret = node[:32]
                pub = public(secret)
                keys[name] = {"derivationVersion":2,"path":"m/"+"/".join(f"{p}'" for p in path),"publicKey":b58(pub),"commitment":"0x"+hashlib.sha256(pub).hexdigest()}
                secrets[name] = secret
            identity = public(secrets["deployment"])
            wallet,bump = pda(program,[b"wallet-v1",identity,struct.pack("<I",account_index)])
            root = lambda name: bytes.fromhex(keys[name]["commitment"][2:])
            destination = public(bytes([242])*32)
            target = public(bytes([243])*32)
            initial_state = b"HNYBUNK1"+network+identity+struct.pack("<IIIQ",account_index,0,0,0)+root("owner0")+root("recovery0")+bytes([bump])
            init = b"\0"+network+identity+struct.pack("<I",account_index)+root("owner0")+root("recovery0")
            prefix = b"\1"+struct.pack("<IIQQQ",0,0,0,3,100)+root("owner1")
            native = prefix+b"\0"+struct.pack("<Q",1000000)
            cpi = prefix+bytes([1,2,1,2])+struct.pack("<H",3)+bytes([9,8,7])
            recovery = b"\2"+struct.pack("<I",0)+root("nextOwner")+root("nextRecovery")
            vectors = []
            for name, signer, data, action_keys in [("initialize","deployment",init,[]),("native","owner0",native,[destination]),("cpi","owner0",cpi,[target,destination,wallet]),("recover","recovery0",recovery,[])]:
                digest = hashlib.sha256(b"HoneyBunkSolanaV1"+program+wallet+network+struct.pack("<I",len(data))+data+struct.pack("<H",len(action_keys))+b"".join(action_keys)).digest()
                signature = sign(secrets[signer],digest)
                proof = bytes([1,0])+struct.pack("<7H",48,65535,16,65535,112,32,65535)+public(secrets[signer])+signature+digest
                vectors.append({"name":name,"instruction":data.hex(),"digest":"0x"+digest.hex(),"signature":signature.hex(),"precompile":proof.hex()})
            result.append({"scope":{"genesisHash":b58(network),"program":b58(program),"accountIndex":account_index},"keys":keys,"wallet":b58(wallet),"bump":bump,"state":initial_state.hex(),"spentOwner":b58(pda(program,[b"spent-v1",wallet,root("owner0")])[0]),"payer":b58(public(bytes([241])*32)),"destination":b58(destination),"target":b58(target),"vectors":vectors})
        output = {"warning":"PUBLIC test phrase; NEVER use these keys for funds. Native and CPI are alternative vectors, not permission to sign competing operations.","phrase":PHRASE,"cases":result}
        if "--check" in sys.argv:
            assert json.loads(TARGET.read_text()) == output, "independent Solana phrase vectors changed"
            print("4 scope cases, 28 role keys and 16 authorization vectors match")
        else:
            TARGET.write_text(json.dumps(output,indent=2)+"\n")


if __name__ == "__main__":
    main()
