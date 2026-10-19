"""Own a fresh, isolated Bitcoin Core regtest node. Never connect to a public chain."""
import argparse
import base64
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bitcoind', type=Path, required=True)
    parser.add_argument('--client-bundle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    binary = args.bitcoind.resolve()
    work = Path(tempfile.mkdtemp(prefix='honey-bitcoin-regtest-'))
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    command = [str(binary), '-regtest', '-server', '-listen=0', '-connect=0', '-dnsseed=0',
               '-discover=0', '-txindex=1', '-blockfilterindex=1', '-fallbackfee=0.0001', '-printtoconsole=1',
               f'-datadir={work}', f'-rpcport={port}', '-rpcbind=127.0.0.1', '-rpcallowip=127.0.0.1']
    log = (work/'node.log').open('w')
    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
    url = f'http://127.0.0.1:{port}'
    cookie = work/'regtest/.cookie'
    auth = None

    def rpc(method, params=None, wallet=False):
        data = json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params or []}).encode()
        req = urllib.request.Request(url+('/wallet/miner' if wallet else ''),data=data,
                                     headers={'Content-Type':'application/json','Authorization':auth})
        with urllib.request.urlopen(req,timeout=20) as response:
            result = json.load(response,parse_float=Decimal)
        assert not result.get('error'), result.get('error')
        return result['result']

    counter = 0
    def client(request, expected_error=None):
        nonlocal counter
        if request.get('kind') in ['history', 'review']:
            height = rpc('getblockcount')
            for _ in range(100):
                index = rpc('getindexinfo').get('basic block filter index', {})
                # Invalidation can lower the active tip below the latest indexed
                # block. The scanner separately verifies canonical block hashes.
                if index.get('synced') and index.get('best_block_height', -1) >= height: break
                time.sleep(0.1)
            else: raise RuntimeError(f'Owned block filter index did not synchronize: tip={height}, index={index}')
        path = work/f'public-request-{counter}.json'; counter += 1
        path.write_text(json.dumps({'network':'regtest',**request}))
        result = subprocess.run(['node','--input-type=module','-e',
            "import fs from 'node:fs'; import {pathToFileURL} from 'node:url'; import {DatabaseSync} from 'node:sqlite'; "
            "const m=await import(pathToFileURL(process.argv[1]).href); "
            "const rpc={async request(method,params){const r=await fetch(process.argv[3],{method:'POST',"
            "headers:{'Content-Type':'application/json',Authorization:'Basic '+Buffer.from(fs.readFileSync(process.argv[4],'utf8').trim()).toString('base64')},"
            "body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});"
            "const body=await r.json(); if(body.error)throw Object.assign(new Error(body.error.message),{code:body.error.code});return body.result;}}; "
            "const request=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); "
            "const db=(request.saveApproval||request.kind==='savedApproval')?new DatabaseSync(process.argv[5]):null; "
            "const sqlite=db?{async execAsync(sql){db.exec(sql)},async getFirstAsync(sql,...args){return db.prepare(sql).get(...args)??null},async runAsync(sql,...args){return {changes:Number(db.prepare(sql).run(...args).changes)}}}:undefined; "
            "try{console.log(JSON.stringify(await m.probe(request,rpc,sqlite)))}finally{db?.close()}",
            str(args.client_bundle.resolve()),str(path),url,str(cookie),str(work/'approval.sqlite')],timeout=40,capture_output=True,text=True)
        if expected_error:
            assert result.returncode != 0 and expected_error in result.stderr, result.stderr
            return {'rejected':expected_error}
        assert result.returncode == 0,result.stderr
        return json.loads(result.stdout)

    def journal_snapshot():
        with sqlite3.connect(work/'approval.sqlite') as db:
            rows = db.execute('SELECT revision, record FROM honey_bunk_journal_v1').fetchall()
        assert len(rows)==1 and 'honey-bitcoin-account' not in rows[0][1]
        return {'revision':rows[0][0],'ciphertextSha256':hashlib.sha256(rows[0][1].encode()).hexdigest()}

    try:
        for _ in range(150):
            if process.poll() is not None: raise RuntimeError((work/'node.log').read_text()[-4000:])
            if cookie.exists():
                auth = 'Basic '+base64.b64encode(cookie.read_bytes().strip()).decode()
                try:
                    chain = rpc('getblockchaininfo')
                    break
                except (OSError,AssertionError): pass
            time.sleep(0.1)
        else: raise RuntimeError('Owned regtest node did not become ready')
        assert chain['chain'] == 'regtest'
        info = rpc('getnetworkinfo'); assert info['version'] == 310100, info['version']
        assert info['connections'] == 0
        rpc('createwallet',{'wallet_name':'miner'})
        mining_address = rpc('getnewaddress',[],True)
        rpc('generatetoaddress',[101,mining_address])
        fee_budget = {'maxVbytes':1000,'minimumRateSatPerKvB':'100','maximumRateSatPerKvB':'10000',
                      'maxFeeSatoshis':'1000','fallbackRateSatPerKvB':'1000'}
        fee_policy = client({'kind':'fees','budget':fee_budget})
        observed_policy = fee_policy['observation']
        # Regtest does not supply a realistic confirmation estimate. An explicit
        # fixture fallback must remain labelled as such, even if Core accepts it.
        assert observed_policy['estimate']['status']=='unavailable'
        assert fee_policy['selection']['source']=='explicit-fallback'
        assert fee_policy['selection']['feeRateSatPerKvB']=='1000'
        raw_policy = rpc('getmempoolinfo')
        for app_key,core_key in [('minimumRelaySatPerKvB','minrelaytxfee'),
                                 ('minimumMempoolSatPerKvB','mempoolminfee'),
                                 ('incrementalRelaySatPerKvB','incrementalrelayfee')]:
            assert int(observed_policy[app_key])==int(raw_policy[core_key]*100000000)
        no_fallback = {k:v for k,v in fee_budget.items() if k!='fallbackRateSatPerKvB'}
        missing_estimate = client({'kind':'fees','budget':no_fallback},'explicit fallback required')
        rate_cap = client({'kind':'fees','budget':{**fee_budget,'maximumRateSatPerKvB':'999'}},'fee rate exceeds cap')
        total_cap = client({'kind':'fees','budget':{**fee_budget,'maxFeeSatoshis':'999'}},'estimated fee exceeds cap')
        owners = client({'kind':'owners','indices':[0,1,2,3,4,5]})
        amounts = [160000,90000,110000]
        funding = rpc('sendmany',['',{o['ownerAddress']:v/100000000 for o,v in zip(owners,amounts)}],True)
        repeat_funding = rpc('sendtoaddress',[owners[0]['ownerAddress'],0.0002],True)
        rpc('generatetoaddress',[1,mining_address])
        decoded_funding = rpc('getrawtransaction',[funding,True])
        coins = []
        for index,owner in enumerate(owners[:3]):
            script = '0014'+owner['commitment'][2:]
            output = next(o for o in decoded_funding['vout'] if o['scriptPubKey']['hex']==script)
            sats = int(output['value']*100000000); assert sats==amounts[index]
            coins.append({'txid':funding,'vout':output['n'],'satoshis':str(sats),
                          'ownerIndex':index,'scriptPubKey':script})
        repeated = rpc('getrawtransaction',[repeat_funding,True])
        repeated_script = '0014'+owners[0]['commitment'][2:]
        repeated_output = next(o for o in repeated['vout'] if o['scriptPubKey']['hex']==repeated_script)
        assert int(repeated_output['value']*100000000)==20000
        coins.append({'txid':repeat_funding,'vout':repeated_output['n'],'satoshis':'20000',
                      'ownerIndex':0,'scriptPubKey':repeated_script})
        discovered = client({'kind':'discover'})
        assert [len(c['coins']) for c in discovered['candidates']]==[2,1,1,0,0,0]
        assert [c['confirmedSatoshis'] for c in discovered['candidates']]==['180000','90000','110000','0','0','0']
        assert [c['available'] for c in discovered['candidates']]==[True,True,True,False,False,False]
        assert discovered['inventoryComplete'] is False and discovered['signingAuthorized'] is False
        destination = rpc('getnewaddress',['recipient','bech32m'],True)
        request = {'utxos':coins,'payments':[{'address':destination,'satoshis':'200000'}],
                   'changeIndex':3,'lockTime':rpc('getblockcount'),
                   'feeRateSatPerKvB':fee_policy['selection']['feeRateSatPerKvB'],
                   'maxFeeSat':fee_policy['selection']['maxFeeSatoshis']}
        parent = client({**request,'saveApproval':1000})
        prepared,signed = parent['prepared'],parent['signed']
        assert prepared['maxVbytes']<=fee_policy['selection']['maxVbytes']
        assert int(prepared['feeSatoshis'])<=int(fee_policy['selection']['maxFeeSatoshis'])
        reviewed_parent = client({'kind':'review','spend':request})
        assert reviewed_parent['reserved']['approval']['prepared']==prepared
        assert reviewed_parent['reserved']['approval']['phase']=='approved'
        assert reviewed_parent['reserved']['signingAuthorized'] is False
        incomplete_request = {**request,'utxos':[u for u in coins if u['txid']!=repeat_funding]}
        incomplete_group = client({'kind':'review','spend':incomplete_request},'selected owner group changed or incomplete')
        assert [u['ownerIndex'] for u in prepared['selected']]==[0,0,2]
        decoded = rpc('decoderawtransaction',[signed['rawTransaction']])
        assert (decoded['txid'],decoded['hash'],decoded['vsize'],decoded['weight']) == (
            signed['txid'],signed['wtxid'],signed['vbytes'],signed['weight'])
        assert signed['vbytes'] <= prepared['maxVbytes']
        accept = rpc('testmempoolaccept',[[signed['rawTransaction']]])[0]
        assert accept['allowed'],accept
        assert int(accept['fees']['base']*100000000)==int(prepared['feeSatoshis'])
        # Wrong input-value metadata produces an invalid witness on the real node.
        wrong_request = json.loads(json.dumps(request)); wrong_request['utxos'][0]['satoshis']='160001'
        wrong = client(wrong_request)
        wrong_result = rpc('testmempoolaccept',[[wrong['signed']['rawTransaction']]])[0]
        assert wrong_result['allowed'] is False,wrong_result
        # Replacing the recipient script after signing cannot preserve approval.
        old_script = prepared['transaction']['outputs'][0]['scriptPubKey']
        changed_raw = signed['rawTransaction'].replace(old_script,'5120'+'22'*32,1)
        changed_result = rpc('testmempoolaccept',[[changed_raw]])[0]
        assert changed_result['allowed'] is False,changed_result
        parent_saved = parent['savedApproval']; parent_journal = journal_snapshot()
        before_submit = client({'kind':'savedApproval','saved':parent_saved,'action':'observe'})
        assert before_submit['status']=='not-observed'
        uncertain_submit = client({'kind':'savedApproval','saved':parent_saved,'action':'submit',
                                   'dropSendAcknowledgement':True},'submission outcome uncertain')
        parent_retry = client({'kind':'savedApproval','saved':parent_saved,'action':'submit'})
        assert parent_retry['outcome']=='already-observed' and parent_retry['observation']['status']=='pending'
        assert journal_snapshot()==parent_journal
        assert rpc('sendrawtransaction',[signed['rawTransaction']])==signed['txid']
        pending_discovery = client({'kind':'discover','previousCheckpoint':discovered['checkpoint']})
        assert [c['available'] for c in pending_discovery['candidates']]==[False,True,False,False,False,False]
        assert all(c['status']=='mempool-spent' for i in [0,2] for c in pending_discovery['candidates'][i]['coins'])
        # Fee bump as a child using the NEW change owner; the parent bytes stay fixed.
        change_vout = len(decoded['vout'])-1
        change_coin = {'txid':signed['txid'],'vout':change_vout,'satoshis':prepared['changeSatoshis'],
                       'ownerIndex':3,'scriptPubKey':'0014'+owners[3]['commitment'][2:]}
        # Local mining-priority deltas must not masquerade as actual paid fees.
        rpc('prioritisetransaction',[signed['txid'],0,10000])
        pending_observation = client({'kind':'observe','inputs':[*prepared['selected'],change_coin]})
        assert [u['status'] for u in pending_observation['inputs']]==['unavailable','unavailable','unavailable','unconfirmed']
        assert pending_observation['ancestorVbytes']==signed['vbytes']
        assert pending_observation['ancestorFeeSatoshis']==prepared['feeSatoshis']
        wrong_coin = {**change_coin,'satoshis':str(int(change_coin['satoshis'])+1)}
        client({'kind':'observe','inputs':[wrong_coin]},'coin changed or inconsistent')
        child_request = {'utxos':[change_coin], 'payments':[{'address':rpc('getnewaddress',[],True),'satoshis':'15000'}],
                        'changeIndex':4,'lockTime':rpc('getblockcount'),'feeRateSatPerKvB':'1000',
                        'targetPackageRateSatPerKvB':'5000','maxFeeSat':'2000'}
        child = client({**child_request,'saveApproval':1001})
        rpc('prioritisetransaction',[signed['txid'],0,-10000])
        child_signed = child['signed']
        reviewed_child_request = {**child_request,'feeRateSatPerKvB':child['cpfp']['budget']['feeRateSatPerKvB']}
        pending_consent = client({'kind':'review','spend':reviewed_child_request,'targetFeeRate':'5000'},'unconfirmed consent missing')
        reviewed_child = client({'kind':'review','spend':reviewed_child_request,'targetFeeRate':'5000','allowUnconfirmed':True})
        assert reviewed_child['reserved']['approval']['prepared']==child['prepared']
        assert reviewed_child['reviewed']['packageBudget']['ancestorFeeSatoshis']==prepared['feeSatoshis']
        assert child['cpfp']['budget']['ancestorFeeSatoshis']==prepared['feeSatoshis']
        assert int(prepared['feeSatoshis'])+int(child['prepared']['feeSatoshis']) >= 5*(signed['vbytes']+child_signed['vbytes'])
        child_accept = rpc('testmempoolaccept',[[child_signed['rawTransaction']]])[0]
        assert child_accept['allowed'],child_accept
        child_saved = child['savedApproval']; child_journal = journal_snapshot()
        child_submit = client({'kind':'savedApproval','saved':child_saved,'action':'submit'})
        assert child_submit['outcome']=='submitted' and child_submit['wtxid']==child_signed['wtxid']
        assert journal_snapshot()==child_journal
        final_vout = len(child['prepared']['transaction']['outputs'])-1
        final_expected = {'txid':child_signed['txid'],'vout':final_vout,'ownerIndex':4,
                          'satoshis':child['prepared']['changeSatoshis'],'scriptPubKey':'0014'+owners[4]['commitment'][2:]}
        two_ancestors = client({'kind':'observe','inputs':[change_coin,final_expected]})
        assert [u['status'] for u in two_ancestors['inputs']]==['unavailable','unconfirmed']
        assert len(two_ancestors['unconfirmedTransactions'])==2
        assert two_ancestors['ancestorVbytes']==signed['vbytes']+child_signed['vbytes']
        block = rpc('generatetoaddress',[1,mining_address])[0]
        mined = rpc('getblock',[block])
        assert signed['txid'] in mined['tx'] and child_signed['txid'] in mined['tx']
        for u in prepared['selected']: assert rpc('gettxout',[u['txid'],u['vout']]) is None
        assert rpc('gettxout',[funding,coins[1]['vout']]) is not None
        final_vout = len(child['prepared']['transaction']['outputs'])-1
        final_coin = rpc('gettxout',[child_signed['txid'],final_vout])
        assert final_coin['scriptPubKey']['hex']=='0014'+owners[4]['commitment'][2:]
        assert int(final_coin['value']*100000000)==int(child['prepared']['changeSatoshis'])
        mined_observation = client({'kind':'observe','inputs':[final_expected]})
        assert mined_observation['inputs'][0]['status']=='confirmed'
        assert mined_observation['unconfirmedTransactions']==[]
        mined_discovery = client({'kind':'discover','previousCheckpoint':discovered['checkpoint']})
        assert [len(c['coins']) for c in mined_discovery['candidates']]==[0,1,0,0,1,0]
        included_saved = client({'kind':'savedApproval','saved':child_saved,'action':'observe','minConfirmations':2})
        confirmed_saved = client({'kind':'savedApproval','saved':child_saved,'action':'observe','blockHint':block})
        mined_retry = client({'kind':'savedApproval','saved':child_saved,'action':'submit'})
        assert included_saved['status']=='included' and included_saved['confirmations']==1
        assert confirmed_saved['status']=='confirmed' and confirmed_saved['block']['blockhash']==block
        assert mined_retry['outcome']=='already-observed' and mined_retry['observation']['status']=='confirmed'
        mined_history = client({'kind':'history'})
        assert [c['activityObserved'] for c in mined_history['candidates']] == [True,True,True,True,True,False]
        assert len(mined_history['events']) == 10
        assert all(e['location'] is not None for e in mined_history['events'])
        assert sorted(e['ownerIndex'] for e in mined_history['events'] if e['type']=='spend') == [0,0,2,3]
        assert mined_history['inventoryComplete'] is False and mined_history['signingAuthorized'] is False
        # Explicit block pagination keeps an empty early window distinct from unused keys.
        early_history = client({'kind':'history','blockCount':102})
        assert early_history['events'] == [] and early_history['coverage']['nextHeight'] == 102
        later_history = client({'kind':'history','fromHeight':102,'previousCheckpoint':early_history['checkpoint']})
        assert later_history['events'] == mined_history['events']
        # Reorg and identical-byte rebroadcast; no new owner authorization is made.
        rpc('invalidateblock',[block])
        saved_checkpoint_rejected = client({'kind':'savedApproval','saved':child_saved,'action':'observe',
                                            'previousCheckpoint':confirmed_saved['checkpoint']},'checkpoint reorganized')
        orphaned_saved = client({'kind':'savedApproval','saved':child_saved,'action':'observe','blockHint':block})
        reorg_saved = client({'kind':'savedApproval','saved':child_saved,'action':'submit'})
        assert orphaned_saved['status']=='orphaned'
        assert reorg_saved['outcome']=='already-observed' and reorg_saved['observation']['status']=='pending'
        changed_checkpoint = client({'kind':'discover','previousCheckpoint':mined_discovery['checkpoint']},'checkpoint reorganized')
        client({'kind':'observe','inputs':[final_expected],'previousCheckpoint':mined_observation['checkpoint']},'checkpoint reorganized')
        history_checkpoint_rejected = client({'kind':'history','previousCheckpoint':mined_history['checkpoint']},'checkpoint reorganized')
        reorg_history = client({'kind':'history'})
        assert len(reorg_history['events']) == 10
        assert sum(e['location'] is None for e in reorg_history['events']) == 6
        reorg_observation = client({'kind':'observe','inputs':[final_expected]})
        assert reorg_observation['inputs'][0]['status']=='unconfirmed'
        assert len(reorg_observation['unconfirmedTransactions'])==2
        mempool = rpc('getrawmempool')
        assert signed['txid'] in mempool and child_signed['txid'] in mempool
        assert rpc('sendrawtransaction',[signed['rawTransaction']])==signed['txid']
        assert rpc('sendrawtransaction',[child_signed['rawTransaction']])==child_signed['txid']
        # Fast regtest mining can recreate the exact invalidated block header.
        # A new timestamp makes this a distinct replacement block.
        rpc('setmocktime',[max(int(time.time()),mined['time'])+1])
        replacement_block = rpc('generatetoaddress',[1,mining_address])[0]
        assert replacement_block != block
        assert rpc('gettxout',[child_signed['txid'],final_vout])['confirmations']==1
        replacement_discovery = client({'kind':'discover','previousCheckpoint':discovered['checkpoint']})
        assert replacement_discovery['candidates'][4]['confirmedSatoshis']==child['prepared']['changeSatoshis']
        replacement_saved = client({'kind':'savedApproval','saved':child_saved,'action':'observe'})
        assert replacement_saved['status']=='confirmed' and replacement_saved['block']['blockhash']==replacement_block
        assert replacement_saved['wtxid']==child_signed['wtxid'] and journal_snapshot()==child_journal
        # An immature coinbase remains visible and cannot make its group eligible.
        rpc('generatetoaddress',[1,owners[5]['ownerAddress']])
        immature_discovery = client({'kind':'discover'})
        immature = immature_discovery['candidates'][5]
        assert immature['available'] is False and immature['coins'][0]['status']=='immature'
        rpc('generatetoaddress',[99,mining_address])
        mature_discovery = client({'kind':'discover'})
        mature = mature_discovery['candidates'][5]
        assert mature['available'] is True and mature['coins'][0]['confirmations']==100
        late_txid = rpc('sendtoaddress',[owners[0]['ownerAddress'],0.0003],True)
        late_history = client({'kind':'history'})
        late_events = [e for e in late_history['events'] if e['type']=='receive' and e['txid']==late_txid]
        assert len(late_events)==1 and late_events[0]['ownerIndex']==0
        assert late_events[0]['satoshis']=='30000' and late_events[0]['location'] is None
        assert any(e['type']=='spend' and e['ownerIndex']==0 for e in late_history['events'])
        evidence = {'scope':'Public-fixture local Bitcoin Core regtest construction/signature/CPFP/reorg, UTXO and spent/received history acceptance; no production signer, journal restoration or public-network activation',
                    'coreVersion':info['version'],'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),
                    'network':'regtest','connections':info['connections'],'genesis':rpc('getblockhash',[0]),
                    'feePolicy':{'observedAndSelected':fee_policy,'missingEstimateRejected':missing_estimate,
                                 'rateCapRejected':rate_cap,'totalCapRejected':total_cap,
                                 'selectedRateUsedByAcceptedParent':True},
                    'savedSubmission':{'before':before_submit,'lostAcknowledgement':uncertain_submit,
                                       'parentRetry':parent_retry,'childSubmitted':child_submit,
                                       'included':included_saved,'confirmed':confirmed_saved,'minedRetry':mined_retry,
                                       'obsoleteCheckpoint':saved_checkpoint_rejected,'orphaned':orphaned_saved,
                                       'reorgRetry':reorg_saved,'replacement':replacement_saved,
                                       'parentJournal':parent_journal,'childJournal':child_journal,
                                       'journalUnchangedBySubmissionsAndObservations':True,
                                       'storageScope':'Real encrypted SQLite reopened in fresh processes; no signature computation on retries'},
                    'approvalReview':{'confirmedParent':reviewed_parent,'pendingChild':reviewed_child,
                                      'incompleteGroupRejected':incomplete_group,'pendingConsentRequired':pending_consent,
                                      'storageScope':'In-memory CAS composition; separate SQLite runner proves durable storage'},
                    'parent':parent,'parentAcceptance':accept,'child':child,'childAcceptance':child_accept,
                    'wrongAmountRejected':wrong_result,'changedRecipientRejected':changed_result,
                    'reorgedBlock':block,'replacementBlock':replacement_block,'identicalRebroadcast':True,
                    'inputObservation':{'pending':pending_observation,'twoAncestors':two_ancestors,
                                        'mined':mined_observation,'reorged':reorg_observation},
                    'discovery':{'funded':discovered,'pendingSpend':pending_discovery,'mined':mined_discovery,
                                 'reorganizedCheckpoint':changed_checkpoint,'replacement':replacement_discovery,
                                 'immature':immature_discovery,'mature':mature_discovery},
                    'history':{'mined':mined_history,'earlyWindow':early_history,'laterWindow':later_history,
                               'reorganizedCheckpoint':history_checkpoint_rejected,'reorged':reorg_history,
                               'lateDepositToUsedOwner':late_history},
                    'unselectedInputPreserved':True,'allKnownSelectedOwnerCoinsSpent':True,'workDirectory':str(work)}
        args.output.write_text(json.dumps(evidence,indent=2,default=str)+'\n')
        print('Core verified signatures, fees/weight/IDs, fresh change, CPFP, reorg rebroadcast, UTXO discovery and paginated spent/received history including late pending deposits',flush=True)
    finally:
        try:
            if auth and process.poll() is None: rpc('stop')
        except (OSError,AssertionError): pass
        try: process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
        log.close()
        print(f'Owned regtest stopped; public fixtures/logs retained at {work}',flush=True)


if __name__=='__main__': main()
