"""Real local-validator acceptance using PUBLIC fixture keys, never a user's CLI config."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import random
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
SYSTEM = bytes(32)
TOKEN_TEXT = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
LOADER_TEXT = "BPFLoaderUpgradeab1e11111111111111111111111"


def b58(data):
    n, out = int.from_bytes(data, "big"), ""
    while n:
        n, digit = divmod(n, 58)
        out = ALPHABET[digit] + out
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + out


def un58(text):
    n = 0
    for c in text:
        n = n * 58 + ALPHABET.index(c)
    return bytes(len(text) - len(text.lstrip("1"))) + n.to_bytes((n.bit_length()+7)//8, "big")


def pda(program, seeds):
    prime = 2**255 - 19
    d = -121665 * pow(121666, -1, prime) % prime
    for bump in range(255, -1, -1):
        address = hashlib.sha256(b"".join(seeds) + bytes([bump]) + program + b"ProgramDerivedAddress").digest()
        y = int.from_bytes(address, "little") & ((1 << 255) - 1)
        x2 = (y*y-1) * pow(d*y*y+1, -1, prime) % prime
        if x2 != 0 and pow(x2, (prime-1)//2, prime) != 1:
            return address, bump
    raise AssertionError("no PDA bump")


def short(n):
    out = bytearray()
    while n > 127:
        out.append((n & 127) | 128)
        n >>= 7
    out.append(n)
    return bytes(out)


def ix(program, accounts, data):
    # Accounts are (public key, writable, signer).
    return {"program": program, "accounts": accounts, "data": data}


def sources():
    paths = [ROOT/"Cargo.toml", ROOT/"Cargo.lock", ROOT/"build.rs"]
    for directory, pattern in [("src","*.rs"),("tests","*.rs"),("tests","*.toml"),
                               ("tests/fixtures","*.json"),("scripts","*.py")]:
        paths += list((ROOT/directory).rglob(pattern))
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(paths)}


def ports():
    # Reserve/check every TCP and UDP port in a compact task-owned range. The
    # validator needs multiple dynamic ports in addition to RPC/pubsub/faucet.
    for _ in range(50):
        start = random.randrange(20000, 45000)
        held = []
        try:
            for port in range(start, start+40):
                for kind in [socket.SOCK_STREAM, socket.SOCK_DGRAM]:
                    s = socket.socket(socket.AF_INET, kind)
                    held.append(s)
                    s.bind(("127.0.0.1", port))
            return start
        except OSError:
            continue
        finally:
            for s in held:
                s.close()
    raise RuntimeError("no free local validator port range")


class Probe:
    def __init__(self, work, rpc):
        self.work, self.url = work, rpc
        self.keys, self.paths, self.receipts = {}, {}, []
        for n in [1,2,3,4,5,6,7,8,99,210,211,212,238,240,241,242]:
            der = work/f"public-fixture-{n}.der"
            der.write_bytes(bytes.fromhex("302e020100300506032b657004220420") + bytes([n])*32)
            result = subprocess.check_output(["openssl","pkey","-inform","DER","-in",str(der),"-pubout","-outform","DER"])
            assert result[:12] == bytes.fromhex("302a300506032b6570032100")
            self.keys[n], self.paths[n] = result[12:], der
        self.program, self.payer = self.keys[240], self.keys[241]
        self.wallet = pda(self.program, [b"wallet-v1",self.keys[1],struct.pack("<I",7)])[0]
        self.network = None

    def rpc(self, method, params=None):
        assert self.url.startswith("http://127.0.0.1:")
        payload = json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params or []}).encode()
        request = urllib.request.Request(self.url, payload, {"Content-Type":"application/json"})
        with urllib.request.urlopen(request, timeout=15) as response:
            result = json.load(response)
        if "error" in result:
            raise RuntimeError(json.dumps(result["error"]))
        return result["result"]

    def sign(self, n, data):
        path = self.work/"public-message.bin"
        path.write_bytes(data)
        return subprocess.check_output(["openssl","pkeyutl","-sign","-rawin","-keyform","DER",
                                        "-inkey",str(self.paths[n]),"-in",str(path)])

    def root(self, n):
        return hashlib.sha256(self.keys[n]).digest()

    def tomb(self, root):
        return pda(self.program,[b"spent-v1",self.wallet,root])[0]

    def controls(self):
        return [(self.wallet,True,False),(self.payer,True,True),
                (un58("Sysvar1nstructions1111111111111111111111111"),False,False),(SYSTEM,False,False)]

    def proof(self, signer, action, keys=()):
        data = action["data"]
        digest = hashlib.sha256(b"HoneyBunkSolanaV1"+self.program+self.wallet+self.network+
                               struct.pack("<I",len(data))+data+struct.pack("<H",len(keys))+b"".join(keys)).digest()
        body = bytes([1,0])+struct.pack("<7H",48,65535,16,65535,112,32,65535)+self.keys[signer]+self.sign(signer,digest)+digest
        assert len(body) == 144
        return ix(un58("Ed25519SigVerify111111111111111111111111111"),[],body)

    def wire(self, instructions, blockhash):
        flags = {self.payer:[True,True]}
        for instruction in instructions:
            for key, writable, signer in instruction["accounts"]+[(instruction["program"],False,False)]:
                old = flags.setdefault(key,[False,False])
                old[0] |= writable
                old[1] |= signer
        ordered = [self.payer]
        for signer,writable in [(True,True),(True,False),(False,True),(False,False)]:
            ordered += [k for k,f in flags.items() if k != self.payer and f == [writable,signer]]
        signers = [k for k in ordered if flags[k][1]]
        header = bytes([len(signers),sum(flags[k] == [False,True] for k in ordered),
                        sum(flags[k] == [False,False] for k in ordered)])
        message = header+short(len(ordered))+b"".join(ordered)+un58(blockhash)+short(len(instructions))
        for instruction in instructions:
            metas = bytes(ordered.index(k) for k,_,_ in instruction["accounts"])
            data = instruction["data"]
            message += bytes([ordered.index(instruction["program"])])+short(len(metas))+metas+short(len(data))+data
        by_public = {v:k for k,v in self.keys.items()}
        signatures = [self.sign(by_public[k],message) for k in signers]
        wire = short(len(signers))+b"".join(signatures)+message
        assert len(wire) <= 1232, f"packet too large: {len(wire)}"
        return wire, b58(signatures[0])

    def blockhash(self):
        return self.rpc("getLatestBlockhash",[{"commitment":"confirmed"}])["value"]["blockhash"]

    def submit(self, label, instructions, fail=False):
        blockhash = self.blockhash()
        wire, signature = self.wire(instructions, blockhash)
        result = self.rpc("sendTransaction",[base64.b64encode(wire).decode(),
                          {"encoding":"base64","skipPreflight":fail,"preflightCommitment":"confirmed","maxRetries":3}])
        assert result == signature
        deadline = time.monotonic()+90
        while time.monotonic() < deadline:
            status = self.rpc("getSignatureStatuses",[[signature],{"searchTransactionHistory":True}])["value"][0]
            if status and status["confirmationStatus"] == "finalized":
                assert (status["err"] is not None) == fail, (label,status)
                tx = self.rpc("getTransaction",[signature,{"encoding":"json","commitment":"finalized","maxSupportedTransactionVersion":0}])
                if not tx:
                    time.sleep(.2)
                    continue
                assert tx["meta"]["err"] == status["err"]
                row = {"case":label,"signature":signature,"slot":status["slot"],"error":status["err"],
                       "blockhash":blockhash,"wireBytes":len(wire),"computeUnits":tx["meta"].get("computeUnitsConsumed"),
                       "logs":tx["meta"]["logMessages"]}
                self.receipts.append(row)
                print(f"Finalized {label}: {'expected failure' if fail else 'success'} at slot {status['slot']}",flush=True)
                return row
            time.sleep(.2)
        raise RuntimeError(f"finalized transaction timed out: {label}")

    def rejected_simulation(self, label, instructions):
        wire,_ = self.wire(instructions,self.blockhash())
        result = self.rpc("simulateTransaction",[base64.b64encode(wire).decode(),
                          {"encoding":"base64","sigVerify":True,"commitment":"confirmed"}])["value"]
        assert result["err"] is not None, label
        self.receipts.append({"case":label,"simulationOnly":True,"error":result["err"],"logs":result["logs"]})
        return result

    def account(self, key):
        result = self.rpc("getAccountInfo",[b58(key),{"encoding":"base64","commitment":"finalized"}])["value"]
        if result is None:
            return None
        result["raw"] = base64.b64decode(result["data"][0])
        return result

    def state(self):
        account = self.account(self.wallet)
        assert account["owner"] == b58(self.program) and not account["executable"]
        raw = account["raw"]
        assert len(raw) == 157 and raw[:8] == b"HNYBUNK1" and raw[8:40] == self.network
        index,epoch,owner,nonce = struct.unpack_from("<IIIQ",raw,72)
        assert index == 7 and raw[40:72] == self.keys[1]
        return {"epoch":epoch,"index":owner,"nonce":nonce,"owner":raw[92:124],
                "recovery":raw[124:156],"lamports":account["lamports"]}

    def init(self):
        data = bytes([0])+self.network+self.keys[1]+struct.pack("<I",7)+self.root(2)+self.root(3)
        accounts = self.controls()+[(self.tomb(self.root(2)),False,False),(self.tomb(self.root(3)),False,False)]
        action = ix(self.program,accounts,data)
        return [self.proof(1,action),action]

    def native(self, signer, successor, amount, slot):
        state = self.state()
        data = bytes([1])+struct.pack("<IIQQQ",state["epoch"],state["index"],state["nonce"],0,slot+10000)
        data += self.root(successor)+bytes([0])+struct.pack("<Q",amount)
        accounts = self.controls()+[(self.tomb(state["owner"]),True,False),(self.tomb(self.root(successor)),False,False),
                                    (self.keys[242],True,False)]
        action = ix(self.program,accounts,data)
        return [self.proof(signer,action,[self.keys[242]]),action]

    def recovery(self):
        state = self.state()
        data = bytes([2])+struct.pack("<I",state["epoch"])+self.root(5)+self.root(6)
        accounts = self.controls()+[(self.tomb(state["owner"]),True,False),(self.tomb(state["recovery"]),True,False),
                                    (self.tomb(self.root(5)),False,False),(self.tomb(self.root(6)),False,False)]
        action = ix(self.program,accounts,data)
        return [self.proof(3,action),action]

    def cpi(self, slot):
        state = self.state()
        metas = [(self.keys[211],True,False),(self.keys[210],False,False),
                 (self.keys[212],True,False),(self.wallet,False,True)]
        payload = bytes([12])+struct.pack("<Q",50)+bytes([6])  # SPL transferChecked
        data = bytes([1])+struct.pack("<IIQQQ",state["epoch"],state["index"],state["nonce"],0,slot+10000)+self.root(8)
        data += bytes([1,len(metas)])+bytes(int(w) | (int(s)<<1) for _,w,s in metas)+struct.pack("<H",len(payload))+payload
        accounts = self.controls()+[(self.tomb(state["owner"]),True,False),(self.tomb(self.root(8)),False,False),
                                    (un58(TOKEN_TEXT),False,False)]+[(k,w,False) for k,w,_ in metas]
        action = ix(self.program,accounts,data)
        return [self.proof(7,action,[un58(TOKEN_TEXT)]+[k for k,_,_ in metas]),action]

    def transfer(self, destination, amount):
        return ix(SYSTEM,[(self.payer,True,True),(destination,True,False)],struct.pack("<IQ",2,amount))

    def token_setup(self):
        token = un58(TOKEN_TEXT)
        for n,size in [(210,82),(211,165),(212,165)]:
            rent = self.rpc("getMinimumBalanceForRentExemption",[size,{"commitment":"finalized"}])
            create = ix(SYSTEM,[(self.payer,True,True),(self.keys[n],True,True)],
                        struct.pack("<IQQ",0,rent,size)+token)
            if n == 210:
                initialize = ix(token,[(self.keys[n],True,False)],bytes([20,6])+self.payer+bytes([0]))
            else:
                initialize = ix(token,[(self.keys[n],True,False),(self.keys[210],False,False)],
                                bytes([18])+(self.wallet if n == 211 else self.keys[242]))
            self.submit(f"create token fixture {n}",[create,initialize])

    def exercise(self):
        self.submit("prefund undeployed PDA",[self.transfer(self.wallet,20_000_000)])
        init = self.init()
        wrong = ix(self.program,init[1]["accounts"],bytes([0])+bytes([9])*32+init[1]["data"][33:])
        self.rejected_simulation("wrong network initialization",[self.proof(1,wrong),wrong])
        self.submit("initialize prefunded wallet",init)
        original = self.state()
        assert (original["epoch"],original["index"],original["nonce"],original["lamports"]) == (0,0,0,20_000_000)
        self.submit("fund forbidden successor-payer fixtures",[self.transfer(self.keys[n],10_000_000) for n in [4,5,6]])
        transport_payer = self.payer
        try:
            for n in [4,5,6]:
                self.payer = self.keys[n]
                candidate = self.native(2,4,1, self.rpc("getSlot",[{"commitment":"confirmed"}])) if n == 4 else self.recovery()
                result = self.rejected_simulation(f"successor authority {n} as transport payer",candidate)
                assert result["err"] == {"InstructionError":[1,{"Custom":1}]}
                assert any(b58(self.program)+" invoke" in line for line in result["logs"])
        finally:
            self.payer = transport_payer
        assert self.state() == original
        recovery = self.recovery()
        recovery_proof = recovery[0]["data"]
        slot = self.rpc("getSlot",[{"commitment":"confirmed"}])
        native = self.native(2,4,1_000_000,slot)
        broken = ix(native[0]["program"],[],native[0]["data"][:48]+bytes([native[0]["data"][48]^1])+native[0]["data"][49:])
        self.rejected_simulation("invalid Ed25519 signature",[broken,native[1]])
        failed = self.submit("later instruction rollback",[native[0],native[1],self.transfer(self.keys[242],2**64-1)],True)
        assert failed["error"]["InstructionError"][0] == 2
        assert f"Program {b58(self.program)} success" in failed["logs"]
        assert self.state() == original and self.account(self.tomb(self.root(2))) is None
        success = self.submit("identical native authorization retry",native)
        assert success["blockhash"] != failed["blockhash"]
        state = self.state()
        assert (state["index"],state["nonce"],state["lamports"]) == (1,1,19_000_000)
        stale = self.native(4,7,1_000_000,slot)
        recovery[1]["accounts"][4] = (self.tomb(state["owner"]),True,False)
        assert recovery[0]["data"] == recovery_proof
        self.submit("pre-signed independent recovery after owner advance",recovery)
        state = self.state()
        assert (state["epoch"],state["index"],state["nonce"],state["lamports"]) == (1,0,1,19_000_000)
        assert state["owner"] == self.root(5) and state["recovery"] == self.root(6)
        self.rejected_simulation("stale generation authorization",stale)
        self.rejected_simulation("recovery replay",recovery)
        self.submit("new generation native action",self.native(5,7,1_000_000,slot))
        self.token_setup()
        cpi = self.cpi(self.rpc("getSlot",[{"commitment":"confirmed"}]))
        before = self.state()
        failed = self.submit("insufficient-token CPI rollback",cpi,True)
        assert any(TOKEN_TEXT+" invoke" in line for line in failed["logs"])
        assert any(TOKEN_TEXT+" failed:" in line for line in failed["logs"])
        assert self.state() == before and self.account(self.tomb(self.root(7))) is None
        mint = ix(un58(TOKEN_TEXT),[(self.keys[210],True,False),(self.keys[211],True,False),(self.payer,False,True)],
                  bytes([7])+struct.pack("<Q",100))
        self.submit("fund token fixture",[mint])
        success = self.submit("identical CPI authorization retry",cpi)
        assert success["blockhash"] != failed["blockhash"]
        final = self.state()
        assert (final["epoch"],final["index"],final["nonce"],final["lamports"]) == (1,2,3,18_000_000)
        assert final["owner"] == self.root(8)
        for n in [211,212]:
            assert self.rpc("getTokenAccountBalance",[b58(self.keys[n]),{"commitment":"finalized"}])["value"]["amount"] == "50"
        for n in [2,3,4,5,7]:
            spent = self.account(self.tomb(self.root(n)))
            assert spent["owner"] == b58(self.program) and spent["raw"] == b"HNYSPNT1"
        assert self.account(self.tomb(self.root(8))) is None
        return {k:v.hex() if isinstance(v,bytes) else v for k,v in final.items()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--client-bundle",type=Path)
    args = parser.parse_args()
    work = Path(tempfile.mkdtemp(prefix="honey-solana-validator-"))
    process = None
    before = sources()
    fixture = ROOT/"target/deploy/honey_bunk_solana.so"
    fixture_hash = hashlib.sha256(fixture.read_bytes()).hexdigest()
    start = ports()
    probe = Probe(work,f"http://127.0.0.1:{start}")
    for n in [238,240,241]:
        (work/f"public-{n}.json").write_text(json.dumps(list(bytes([n])*32+probe.keys[n])))
    config = work/"cli.yml"
    config.write_text(f'json_rpc_url: "{probe.url}"\nwebsocket_url: "ws://127.0.0.1:{start+1}"\nkeypair_path: "{work}/public-241.json"\naddress_labels: {{}}\ncommitment: finalized\n')
    command = ["solana-test-validator","--config",str(config),"--ledger",str(work/"ledger"),
               "--bind-address","127.0.0.1","--rpc-port",str(start),"--faucet-port",str(start+2),
               "--gossip-port",str(start+3),"--dynamic-port-range",f"{start+4}-{start+39}",
               "--mint",b58(probe.payer),"--ticks-per-slot","8","--quiet"]
    try:
        with (work/"validator.log").open("w") as log:
            process = subprocess.Popen(command,cwd=work,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        deadline = time.monotonic()+90
        while True:
            if process.poll() is not None:
                raise RuntimeError(f"owned validator exited {process.returncode}; inspect {work}/validator.log")
            try:
                if probe.rpc("getHealth") == "ok":
                    break
            except (OSError,ValueError,RuntimeError):
                if time.monotonic() >= deadline:
                    raise RuntimeError("owned validator readiness timeout")
                time.sleep(.5)
        genesis = probe.rpc("getGenesisHash")
        probe.network = un58(genesis)
        assert len(probe.network) == 32
        print(f"Local validator ready; genesis {genesis}; work {work}",flush=True)
        env = {**os.environ,"BUNK_SOLANA_GENESIS_HEX":probe.network.hex()}
        output = work/"deploy"
        with (work/"build.log").open("w") as log:
            subprocess.run(["cargo","build-sbf","--manifest-path",str(ROOT/"Cargo.toml"),
                            "--sbf-out-dir",str(output),"--","--locked","--offline"],
                           env=env,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=180)
        artifact = (output/"honey_bunk_solana.so").read_bytes()
        cli = ["solana","--config",str(config),"--url",probe.url,"--keypair",str(work/"public-241.json")]
        with (work/"deployment.log").open("w") as log:
            subprocess.run(cli+["program","deploy",str(output/"honey_bunk_solana.so"),"--program-id",str(work/"public-240.json"),
                               "--buffer",str(work/"public-238.json"),"--final","--use-rpc","--commitment","finalized",
                               "--output","json"],cwd=work,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=180)
        deployed = probe.account(probe.program)
        assert deployed["executable"] and deployed["owner"] == LOADER_TEXT
        assert deployed["raw"][:4] == struct.pack("<I",2)
        program_data_address = deployed["raw"][4:36]
        program_data = probe.account(program_data_address)
        raw = program_data["raw"]
        assert program_data["owner"] == LOADER_TEXT and raw[:4] == struct.pack("<I",3) and raw[12] == 0
        assert raw[45:45+len(artifact)] == artifact and not any(raw[45+len(artifact):])
        print("Immutable deployment code matches built binary",flush=True)
        final = probe.exercise()
        client_report = None
        if args.client_bundle:
            from client import exercise_client
            client_report = exercise_client(probe,args.client_bundle,b58,un58,ix,TOKEN_TEXT)
        assert probe.rpc("getGenesisHash") == genesis
        assert sources() == before, "sources changed during validator acceptance"
        assert hashlib.sha256(fixture.read_bytes()).hexdigest() == fixture_hash, "fixture binary overwritten"
        report = {"scope":"Isolated loopback Agave validator, public scalar fixture keys and immutable local deployment; not public-provider, phrase-client, app or production certification",
                  "validatorVersion":probe.rpc("getVersion"),"genesis":genesis,"genesisHex":probe.network.hex(),
                  "program":b58(probe.program),"programData":b58(program_data_address),"immutable":True,
                  "artifactSha256":hashlib.sha256(artifact).hexdigest(),"artifactBytes":len(artifact),
                  "deployedCodeMatched":True,"fixtureArtifactPreserved":fixture_hash,"sourcesSha256":before,
                  "sourcesRechecked":True,"wallet":b58(probe.wallet),"finalState":final,
                  "receipts":probe.receipts,"workDirectory":str(work),"validatorCommand":command}
        if client_report:
            report["phraseClient"] = client_report
        args.output.write_text(json.dumps(report,indent=2)+"\n")
        print(f"Validator acceptance passed; evidence {args.output}",flush=True)
    finally:
        if process and process.poll() is None:
            os.killpg(process.pid,signal.SIGTERM)
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid,signal.SIGKILL)
                process.wait(timeout=10)
        if process:
            assert process.poll() is not None
        shutil.rmtree(work/"ledger",ignore_errors=True)
        print(f"Owned validator stopped; logs/artifacts retained in {work}",flush=True)


if __name__ == "__main__":
    main()
