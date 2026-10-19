"""Run bundled shared TS client on PUBLIC fixtures against the owned validator."""
import hashlib
import json
from pathlib import Path
import subprocess
from concurrent.futures import ThreadPoolExecutor
from itertools import count


def exercise_client(probe, bundle, b58, un58, ix, token_text):
    bundle = Path(bundle).resolve()
    bundle_hash = hashlib.sha256(bundle.read_bytes()).hexdigest()
    scope = {"genesisHash":b58(probe.network),"program":b58(probe.program),"accountIndex":9}
    request_path = probe.work/"public-client-request.json"

    def client(kind, account=None, **extra):
        request_path.write_text(json.dumps({"kind":kind,"scope":scope,"payer":b58(probe.payer),
                                           "destination":b58(probe.keys[242]),"account":account,**extra}))
        # Arguments are paths; no shell expansion, user config, secret or network.
        command = ["node","--input-type=module","-e",
                   "import fs from 'node:fs'; import {pathToFileURL} from 'node:url'; const m=await import(pathToFileURL(process.argv[1]).href); console.log(JSON.stringify(m.prepare(JSON.parse(fs.readFileSync(process.argv[2],'utf8')))));",
                   str(bundle),str(request_path)]
        return json.loads(subprocess.check_output(command,timeout=30))

    def wire(prepared):
        return [ix(un58(i["program"]),[(un58(a["address"]),a["writable"],a["signer"]) for a in i["accounts"]],bytes.fromhex(i["data"])) for i in prepared["instructions"]]

    initial = client("initialize")
    wallet = un58(initial["wallet"])

    def account():
        a = probe.account(wallet)
        return {"address":initial["wallet"],"owner":a["owner"],"executable":a["executable"],"data":a["raw"].hex()}

    def inspect():
        return client("inspect",account())

    start = len(probe.receipts)
    probe.submit("client prefund phrase PDA",[probe.transfer(wallet,20_000_000)])
    probe.submit("client phrase initialization",wire(initial))
    old = account()
    state = inspect()
    assert (state["epoch"],state["ownerIndex"],state["nonce"]) == (0,0,"0")
    recovery = client("recover",old)
    native = client("native",old,validUntil=probe.rpc("getSlot",[{"commitment":"confirmed"}])+10000)
    native_wire = wire(native)
    failed = probe.submit("client included native rollback",native_wire+[probe.transfer(probe.keys[242],2**64-1)],True)
    assert failed["error"]["InstructionError"][0] == 2 and f"Program {b58(probe.program)} success" in failed["logs"]
    assert account() == old and probe.account(native_wire[1]["accounts"][4][0]) is None
    success = probe.submit("client identical native authorization retry",native_wire)
    assert success["blockhash"] != failed["blockhash"]
    state = inspect()
    assert (state["epoch"],state["ownerIndex"],state["nonce"]) == (0,1,"1")
    # A fresh process reconstructs the fixed recovery certificate after advancement.
    later = client("recover",account())
    assert later["digest"] == recovery["digest"] and later["instructions"][0] == recovery["instructions"][0]
    probe.submit("client phrase recovery after advancement",wire(later))
    state = inspect()
    assert (state["epoch"],state["ownerIndex"],state["nonce"]) == (1,0,"1")
    probe.rejected_simulation("client stale old-generation authorization",native_wire)
    probe.rejected_simulation("client recovery replay",wire(later))

    # Existing SPL fixture belongs to the scalar-test wallet. Its destination has
    # 50 tokens and public fixture 242 authority; transfer ownership for this case.
    source, mint, destination = probe.keys[212],probe.keys[210],probe.keys[211]
    token = un58(token_text)
    transfer_authority = ix(token,[(source,True,False),(probe.keys[242],False,True)],bytes([6,2,1])+wallet)
    probe.submit("client token fixture authority",[transfer_authority])
    cpi = client("cpi",account(),validUntil=probe.rpc("getSlot",[{"commitment":"confirmed"}])+10000,
                 tokenProgram=token_text,source=b58(source),mint=b58(mint),destinationToken=b58(destination))
    probe.submit("client phrase SPL CPI",wire(cpi))
    state = inspect()
    assert (state["epoch"],state["ownerIndex"],state["nonce"]) == (1,1,"2")
    assert probe.account(wallet)["lamports"] == 19_000_000
    for key,amount in [(source,"0"),(destination,"100")]:
        assert probe.rpc("getTokenAccountBalance",[b58(key),{"commitment":"finalized"}])["value"]["amount"] == amount
    assert hashlib.sha256(bundle.read_bytes()).hexdigest() == bundle_hash
    journal_report = exercise_journal(probe,bundle,b58,un58,ix)
    return {"scope":scope,"wallet":initial["wallet"],"finalState":state,"bundleSha256":bundle_hash,
            "firstReceipt":start,"receiptCount":len(probe.receipts)-start,
            "initializationDigest":initial["digest"],"nativeDigest":native["digest"],
            "recoveryDigest":recovery["digest"],"cpiDigest":cpi["digest"],
            "journal":journal_report,
            "warning":"Public phrase fixtures and task-owned encrypted SQLite only; no application activation or production provider certification."}


def exercise_journal(probe,bundle,b58,un58,ix):
    program = probe.account(probe.program)
    artifact = (probe.work/"deploy/honey_bunk_solana.so").read_bytes()
    release = {"genesisHash":b58(probe.network),"program":b58(probe.program),
               "programData":b58(program["raw"][4:36]),"codeSha256":"0x"+hashlib.sha256(artifact).hexdigest(),
               "codeLength":len(artifact),"upgradeAuthority":None}
    requests = count()
    account_index = 10000
    import_options = {}
    original_db, restored_db = probe.work/"journal.sqlite",probe.work/"restored.sqlite"
    database = original_db
    key = None
    crash_codes = []
    start = len(probe.receipts)
    valid_until = probe.rpc("getSlot",[{"commitment":"confirmed"}])+20000

    def call(method, crash=False, expected_error=None, **extra):
        request = {"method":method,"database":str(database),"release":release,"rpc":probe.url,
                   "accountIndex":account_index,
                   "key":key,"payer":b58(probe.payer),"destination":b58(probe.keys[242]),
                   "validUntil":str(valid_until),"crashOnSigned":crash,**import_options,**extra}
        path = probe.work/f"public-journal-request-{next(requests)}.json"
        path.write_text(json.dumps(request))
        command = ["node","--input-type=module","-e",
                   "import fs from 'node:fs'; import {pathToFileURL} from 'node:url'; const m=await import(pathToFileURL(process.argv[1]).href); console.log(JSON.stringify(await m.journal(JSON.parse(fs.readFileSync(process.argv[2],'utf8')))));",
                   str(bundle),str(path)]
        result = subprocess.run(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=40)
        if crash:
            assert result.returncode == 73, result.stderr+result.stdout
            crash_codes.append(73)
            return None
        assert result.returncode == 0, result.stderr
        output = json.loads(result.stdout)
        if expected_error:
            assert output.get("error") == expected_error, output
        else:
            assert "error" not in output, output
        return output

    def wire(prepared):
        return [ix(un58(i["program"]),[(un58(a["address"]),a["writable"],a["signer"]) for a in i["accounts"]],bytes.fromhex(i["data"])) for i in prepared["instructions"]]

    initialized = call("start")
    key, wallet = initialized["key"], un58(initialized["wallet"])
    probe.submit("journal prefund undeployed phrase wallet",[probe.transfer(wallet,20_000_000)])
    call("reserve",expected_error="BunkSolanaRestoreRequired")
    call("sign",crash=True,approval="bootstrap")
    assert call("inspect")["bootstrap"] == "signing"
    call("sign",approval="bootstrap",expected_error="BunkSigningUncertain")
    bootstrap = call("sign",approval="bootstrap",reconstruct=True)
    probe.submit("journal reconstructed bootstrap",wire(bootstrap))
    assert call("refresh")["phase"] == "restoring"
    recovery = call("sign",approval="recovery")
    probe.submit("journal initial generation reset",wire(recovery))
    assert call("refresh")["phase"] == "ready"
    # Publish a LOCAL fixture registry from the independently checked deployment.
    # It is deliberately restore-only: obsolete releases must remain discoverable.
    registry = {"format":"honey-bunk-releases","version":1,"revision":1,
                "entries":[{"id":"local-sbf-fixture","use":"restore-only",
                            "family":"solana-v1","release":release}]}
    registry_file = probe.work/"local-release-registry.json"
    registry_file.write_text(json.dumps(registry,indent=2)+"\n")
    registry_pin = "0x"+hashlib.sha256(registry_file.read_bytes()).hexdigest()
    backup_file = probe.work/"public-encrypted-backup.json"
    export_request = probe.work/"public-backup-export.json"
    password = "public fixture backup password"
    export_request.write_text(json.dumps({"release":release,"accountIndex":account_index,
                                         "password":password,"file":str(backup_file)}))
    exported = json.loads(subprocess.check_output(
        ["node","--input-type=module","-e",
         "import fs from 'node:fs'; import {pathToFileURL} from 'node:url'; const m=await import(pathToFileURL(process.argv[1]).href); console.log(JSON.stringify(await m.backup(JSON.parse(fs.readFileSync(process.argv[2],'utf8')))));",
         str(bundle),str(export_request)],timeout=40))
    assert exported["version"] == 2
    assert exported["sha256"] == hashlib.sha256(backup_file.read_bytes()).hexdigest()
    for private_text in ["abandon", "accountIndex", release["genesisHash"], release["program"]]:
        assert private_text not in backup_file.read_text()
    call("reserve")
    call("sign",crash=True,approval="owner")
    assert call("inspect")["owner"] == "signing"
    call("reserve",lamports="2000000",expected_error="BunkJournalConflict")
    call("sign",approval="owner",expected_error="BunkSigningUncertain")
    signed = call("sign",approval="owner",reconstruct=True)
    signed_wire = wire(signed)
    failed = probe.submit("journal included native rollback",signed_wire+[probe.transfer(probe.keys[242],2**64-1)],True)
    assert failed["error"]["InstructionError"][0] == 2
    assert call("refresh")["phase"] == "ready"
    assert call("inspect")["owner"] == "signed"
    retry = call("sign",approval="owner")
    assert retry["instructions"][0] == signed["instructions"][0]
    success = probe.submit("journal persisted native retry",wire(retry))
    assert success["blockhash"] != failed["blockhash"]
    assert call("refresh")["state"]["ownerIndex"] == 1
    database = restored_db
    # Every subsequent call decrypts the file in a new process. Neither the fixture
    # phrase nor the caller's release/index may substitute for imported contents.
    import_options = {"backupFile":str(backup_file),"backupPassword":password,
                      "registryFile":str(registry_file),"registryPin":registry_pin,
                      "release":None,"accountIndex":0}
    rejected_db = probe.work/"rejected-import.sqlite"
    wrong_password = call("start",database=str(rejected_db),backupPassword="wrong password",
                          expected_error="WrongPasswordError")
    assert not rejected_db.exists()
    changed_registry = probe.work/"changed-registry.json"
    changed_registry.write_text(registry_file.read_text()+"\n")
    wrong_pin = call("start",database=str(rejected_db),registryFile=str(changed_registry),
                     expected_error="Error")
    assert "trusted release pin" in wrong_pin["message"] and not rejected_db.exists()
    missing_registry = probe.work/"missing-release-registry.json"
    missing_registry.write_text(json.dumps({**registry,"entries":[]})+"\n")
    missing_pin = "0x"+hashlib.sha256(missing_registry.read_bytes()).hexdigest()
    missing_release = call("start",database=str(rejected_db),registryFile=str(missing_registry),
                           registryPin=missing_pin,expected_error="Error")
    assert "Missing trusted release" in missing_release["message"] and not rejected_db.exists()
    before_restore = call("discover")
    assert before_restore["inventoryComplete"] is False and before_restore["signingAuthorized"] is False
    assert before_restore["nextAccountIndex"] == account_index+2
    before_found,before_empty = before_restore["candidates"]
    assert before_found["wallet"] == b58(wallet) and before_found["lamports"] == "19000000"
    assert (before_found["state"]["epoch"],before_found["state"]["ownerIndex"],before_found["state"]["nonce"]) == (1,1,"1")
    assert before_empty["state"] is None and before_empty["lamports"] == "0"
    assert call("inspect") == {"bootstrap":None,"recovery":None,"owner":None,"encrypted":False}
    call("reserve",expected_error="BunkSolanaRestoreRequired")
    restored = call("start")
    assert restored["key"] == key and not restored["bootstrapRequired"]
    call("sign",crash=True,approval="recovery")
    assert call("inspect")["recovery"] == "signing"
    call("start")
    call("sign",approval="recovery",expected_error="BunkSigningUncertain")
    restore = call("sign",approval="recovery",reconstruct=True)
    probe.submit("journal lost-history reconstructed recovery",wire(restore))
    final = call("refresh")
    assert (final["phase"],final["state"]["epoch"],final["state"]["ownerIndex"],final["state"]["nonce"]) == ("ready",2,0,"1")
    probe.rejected_simulation("journal old owner after phrase restore",signed_wire)
    # Two independent processes race DIFFERENT digests against the same SQLite row.
    def reserve_race(amount):
        try:
            return call("reserve",lamports=amount)
        except AssertionError as error:
            result = error.args[0]
            assert isinstance(result,dict) and result.get("error") == "BunkJournalConflict", result
            return result
    with ThreadPoolExecutor(max_workers=2) as pool:
        race = list(pool.map(reserve_race,["1000000","2000000"]))
    assert sum("error" not in r for r in race) == 1, race
    inspection = call("inspect")
    assert inspection["owner"] == "reserved" and inspection["encrypted"]
    assert probe.account(wallet)["lamports"] == 19_000_000
    # Fresh database: discovery relies on the phrase, trusted release and RPC only.
    discovery = call("discover",database=str(probe.work/"discovery.sqlite"))
    assert discovery["inventoryComplete"] is False and discovery["signingAuthorized"] is False
    assert discovery["nextAccountIndex"] == account_index+2 and len(discovery["candidates"]) == 2
    found, empty = discovery["candidates"]
    assert found["wallet"] == b58(wallet) and found["lamports"] == "19000000"
    assert (found["state"]["epoch"],found["state"]["ownerIndex"],found["state"]["nonce"]) == (2,0,"1")
    assert empty["state"] is None and empty["lamports"] == "0"
    assert call("inspect",database=str(probe.work/"discovery.sqlite")) == {
        "bootstrap":None,"recovery":None,"owner":None,"encrypted":False}
    assert hashlib.sha256(backup_file.read_bytes()).hexdigest() == exported["sha256"]
    assert "0x"+hashlib.sha256(registry_file.read_bytes()).hexdigest() == registry_pin
    print("Encrypted SQLite journal survived three process deaths, exact retry, lost-history recovery and concurrent reservation",flush=True)
    print("Encrypted backup restored sparse account through pinned restore-only registry in fresh processes",flush=True)
    return {"wallet":b58(wallet),"key":key,"final":final,"inspection":inspection,"discovery":discovery,
            "backupImport":{"file":str(backup_file),"artifact":exported,"registryPin":registry_pin,
                            "registryFile":str(registry_file),"releaseUse":"restore-only",
                            "accountIndex":account_index,"beforeRestoreDiscovery":before_restore,
                            "rejections":[wrong_password,wrong_pin,missing_release],
                            "rejectedImportsCreatedNoJournal":True,"filesRechecked":True},
            "processExitCodes":crash_codes,"concurrentReservations":race,
            "firstReceipt":start,"receiptCount":len(probe.receipts)-start,
            "originalDatabase":str(original_db),"restoredDatabase":str(restored_db)}
