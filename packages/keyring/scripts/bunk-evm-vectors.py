"""Public test-phrase oracle: Python/OpenSSL BIP32 + Foundry ABI/Keccak/ECDSA.
No Honey TypeScript, Noble, Scure or viem implementation is used. Never pass real keys.
"""
import argparse
import hashlib
import hmac
import json
from pathlib import Path
import subprocess
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

ROOT=Path(__file__).resolve().parents[1]
TARGET=ROOT/'src/fixtures/bunk-evm-v1.json'
PHRASE='push protect grunt rookie audit pave detect swamp clerk document april venue'
SEED=hashlib.pbkdf2_hmac('sha512',PHRASE.encode(),b'mnemonic',2048)
ORDER=0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141

def derive_parts(parts):
 node=hmac.digest(b'Bitcoin seed',SEED,'sha512')
 for index in parts:
  child=hmac.digest(node[32:],b'\0'+node[:32]+(index+2**31).to_bytes(4,'big'),'sha512')
  tweak=int.from_bytes(child[:32],'big');key=(int.from_bytes(node[:32],'big')+tweak)%ORDER
  assert tweak<ORDER and key!=0
  node=key.to_bytes(32,'big')+child[32:]
 return "m/"+"/".join(f"{i}'" for i in parts),node[:32]

def owner_derive(coin,chain,account,index):
 return derive_parts([7744,1,coin]+[(chain>>(31*i))&0x7fffffff for i in range(8,-1,-1)]+[account,index])

def cast(*args):return subprocess.check_output(['cast',*map(str,args)],text=True).strip()
def kh(raw):return bytes.fromhex(cast('keccak','0x'+raw.hex())[2:])
def hx(raw):return '0x'+raw.hex()
def raw(value):return bytes.fromhex(value.removeprefix('0x'))
def word(n):return n.to_bytes(32,'big')
def address_word(a):return raw(a).rjust(32,b'\0')
def abi(signature,*args):return raw(cast('abi-encode','f('+signature+')',*args))
def signed(key,digest):return cast('wallet','sign','--no-hash','--private-key',hx(key),hx(digest))
def address(key):return hx(kh(ec.derive_private_key(int.from_bytes(key,'big'),ec.SECP256K1()).public_key().public_bytes(Encoding.X962,PublicFormat.UncompressedPoint)[1:])[-20:])
def bootstrap(account):return derive_parts([7744,1,2147483647,60,account])
def typed(name,chain,contract,struct):
 domain=kh(kh(b'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')+kh(name.encode())+kh(b'1')+word(chain)+address_word(contract))
 return kh(b'\x19\x01'+domain+kh(struct))

def fixture():
 # Deliberately synthetic code identities for pure hashing vectors. Live tests use real code.
 labels=['factory','singleton','proxyFactory','entryPoint','module','helper']
 c={name:{'address':'0x'+f'{i+1:x}'*40,'codeHash':hx(kh(name.encode()))} for i,name in enumerate(labels)}
 # Public tiny init-code fixture; not a deployable/approved Safe registry entry.
 c['proxyCreationCode']='0x60006000f3'
 zero='0x'+'00'*20
 initializer=raw(cast('calldata','setup(address[],uint256,address,bytes,address,address,uint256,address)','['+c['module']['address']+']',1,c['helper']['address'],cast('sig','setup()'),c['module']['address'],zero,0,zero))
 cfg_hash=kh(b''.join(address_word(c[n]['address'])+raw(c[n]['codeHash']) for n in labels[1:]))
 vectors=[]
 for chain,account,index in [(1,0,0),(8453,0,0),(1,7,2)]:
  path,key=bootstrap(account);identity=address(key)
  _,owner_key=owner_derive(60,chain,account,index)
  _,next_key=owner_derive(60,chain,account,index+1)
  _,first_key=owner_derive(60,chain,account,0)
  commitment=kh(raw(address(owner_key)));next_commitment=kh(raw(address(next_key)));first_commitment=kh(raw(address(first_key)))
  nonce=kh(abi('string,address,uint32','HoneyBunkAccountV1',identity,account))
  salt=kh(kh(initializer)+nonce)
  init_hash=kh(raw(c['proxyCreationCode'])+address_word(c['singleton']['address']))
  safe=hx(kh(b'\xff'+raw(c['proxyFactory']['address'])+salt+init_hash)[-20:])
  cert_digest=typed('HoneyBunkDeployment',chain,c['factory']['address'],kh(b'BunkDeployment(address identity,uint32 accountIndex,address account,bytes32 commitment,bytes32 configHash)')+address_word(identity)+word(account)+address_word(safe)+first_commitment+cfg_hash)
  cert_sig=signed(key,cert_digest)
  factory_data=cast('calldata','deploy(address,uint32,bytes32,bytes)',identity,account,hx(first_commitment),cert_sig)
  target='0x'+'77'*20;data=cast('calldata','set(uint256)',42)
  calls=raw(cast('sig','executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)'))+abi('(address,uint256,bytes)[]',f'[({target},0,{data})]')
  init_code=raw(c['factory']['address'])+raw(factory_data) if index==0 else b''
  op={'sender':safe,'nonce':str(index),'initCode':hx(init_code),'callData':hx(calls),'verificationGasLimit':'500000','callGasLimit':'500000','preVerificationGas':'100000','maxPriorityFeePerGas':'1000000000','maxFeePerGas':'2000000000','paymasterAndData':'0x'}
  gas=word((500000<<128)|500000);fees=word((10**9<<128)|2*10**9)
  inner=kh(address_word(safe)+word(index)+kh(init_code)+kh(calls)+gas+word(100000)+fees+kh(b''))
  userop_hash=kh(inner+address_word(c['entryPoint']['address'])+word(chain))
  owner_digest=typed('HoneyBunkOwner',chain,c['module']['address'],kh(b'BunkOwnerOperation(bytes32 userOpHash,uint32 ownerIndex,bytes32 nextCommitment,uint48 validAfter,uint48 validUntil)')+userop_hash+word(index)+next_commitment+word(1000)+word(2000))
  signature=signed(owner_key,owner_digest)
  authorization=hx(abi('(uint32,bytes32,uint48,uint48,bytes)',f'({index},{hx(next_commitment)},1000,2000,{signature})'))
  vectors.append({'chainId':str(chain),'accountIndex':account,'ownerIndex':index,'identity':{'path':path,'publicKey':hx(ec.derive_private_key(int.from_bytes(key,'big'),ec.SECP256K1()).public_key().public_bytes(Encoding.X962,PublicFormat.CompressedPoint)),'address':identity},'account':safe,'initialCommitment':hx(first_commitment),'currentCommitment':hx(commitment),'nextCommitment':hx(next_commitment),'deploymentDigest':hx(cert_digest),'deploymentSignature':cert_sig,'factoryData':factory_data,'operation':op,'validity':{'validAfter':1000,'validUntil':2000},'userOpHash':hx(userop_hash),'ownerDigest':hx(owner_digest),'authorization':authorization})
 return {'derivationVersion':1,'phrase':PHRASE,'fixtureOnly':'Synthetic test-only vectors; never fund or deploy these derived identities.','config':c,'initializer':hx(initializer),'configHash':hx(cfg_hash),'vectors':vectors}

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--write',action='store_true');p.add_argument('--check',action='store_true');args=p.parse_args()
 data=fixture()
 if args.write:TARGET.write_text(json.dumps(data,indent=2)+'\n');print('Wrote',TARGET)
 else:
  assert json.loads(TARGET.read_text())==data,'Bunk EVM oracle mismatch'
  print('Independent Bunk EVM oracle: 3 vectors match')
