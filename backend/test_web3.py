"""Actual local EVM + offline Kubo integration. Generated accounts, rollback-only app data."""
import base64
import json
import uuid
import httpx
import pytest
from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3
from test_api import client, native_headers
from app import cache
import web3_services as svc

PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=')

@pytest.fixture(autouse=True)
def local_config(monkeypatch):
    monkeypatch.setattr(svc.config,'web3_enable_local',True)
    for key in cache.scan_iter('web3_challenge:*'):cache.delete(key)

def link(client,headers,account,chain=31337):
    response=client.post('/api/web3/challenge',headers=headers,json={'chain_id':chain,'address':account.address})
    assert response.status_code==200,response.text
    challenge=response.json()
    signature=Web3.to_hex(account.sign_message(encode_defunct(text=challenge['message'])).signature)
    result=client.post('/api/web3/verify',headers=headers,json={'challenge_id':challenge['id'],'signature':signature})
    assert result.status_code==200,result.text
    return result.json()

def send(w3,account,intent):
    assert w3.eth.chain_id==31337
    tx={**intent['transaction'],'nonce':w3.eth.get_transaction_count(account.address),'gasPrice':w3.eth.gas_price}
    for k in ('chainId','gas','value'):tx[k]=int(tx[k],16)
    tx.pop('from')
    raw=account.sign_transaction(tx).raw_transaction
    tx_hash=Web3.to_hex(w3.eth.send_raw_transaction(raw))
    w3.eth.wait_for_transaction_receipt(tx_hash)
    return tx_hash

def prepare(client,headers,wallet,kind,**kwargs):
    result=client.post('/api/web3/intents',headers=headers,json={'request_id':str(uuid.uuid4()),'wallet_id':wallet['id'],'kind':kind,**kwargs})
    assert result.status_code==200,result.text
    return result.json()

def test_config_reports_the_active_metadata_storage(client, monkeypatch):
    monkeypatch.setattr(svc.config, 'ipfs_public', False)
    monkeypatch.setattr(svc.config, 'pinata_jwt', 'configured-for-test')
    assert client.get('/api/web3/config').json()['storage'] == 'pinata_ipfs'
    monkeypatch.setattr(svc.config, 'pinata_jwt', '')
    assert client.get('/api/web3/config').json()['storage'] == 'local_ipfs'
    monkeypatch.setattr(svc.config, 'ipfs_public', True)
    assert client.get('/api/web3/config').json()['storage'] == 'public_ipfs'

def submit(client,headers,intent,tx_hash):
    result=client.post(f"/api/web3/intents/{intent['id']}/submit",headers=headers,json={'tx_hash':tx_hash})
    assert result.status_code==200,result.text
    return result.json()

def test_wallet_proofs_cannot_be_replayed_or_used_by_another_user(client):
    headers=native_headers(client)
    account=Account.create()
    challenge=client.post('/api/web3/challenge',headers=headers,json={'chain_id':31337,'address':account.address}).json()
    bad=Web3.to_hex(Account.create().sign_message(encode_defunct(text=challenge['message'])).signature)
    proof={'challenge_id':challenge['id'],'signature':bad}
    assert client.post('/api/web3/verify',headers=headers,json=proof).status_code==422
    proof['signature']=Web3.to_hex(account.sign_message(encode_defunct(text=challenge['message'])).signature)
    other=native_headers(client,'other-wallet@example.com')
    assert client.post('/api/web3/verify',headers=other,json=proof).status_code==403
    verified=client.post('/api/web3/verify',headers=headers,json=proof)
    assert verified.status_code==200
    assert client.post('/api/web3/verify',headers=headers,json=proof).status_code==409
    assert client.get(f"/api/web3/wallets/{verified.json()['id']}/balances",headers=other).status_code==404
    assert client.post('/api/web3/challenge',headers=headers,json={'chain_id':1,'address':account.address}).status_code==422
    assert client.post('/api/web3/challenge',headers={**headers,'Origin':'https://evil.example'},json={'chain_id':31337,'address':account.address}).status_code==403
    stale=client.post('/api/web3/challenge',headers=headers,json={'chain_id':31337,'address':account.address}).json()
    cache.delete('web3_challenge:'+stale['id'])
    assert client.post('/api/web3/verify',headers=headers,json={**proof,'challenge_id':stale['id']}).status_code==409

def test_metadata_requires_ownership_consent_and_rejects_arbitrary_urls(client,tmp_path,monkeypatch):
    import creator
    monkeypatch.setattr(creator,'MEDIA_ROOT',tmp_path)
    owner=native_headers(client)
    upload=client.post('/api/creator/media',headers={**owner,'content-type':'image/png'},content=PNG).json()
    data={'request_id':str(uuid.uuid4()),'name':'Test asset','media_id':upload['id'],'public_storage_consent':True}
    other=native_headers(client,'media-thief@example.com')
    assert client.post('/api/web3/metadata',headers=other,json=data).status_code==404
    assert client.post('/api/web3/metadata',headers=owner,json={**data,'public_storage_consent':False}).status_code==422
    assert client.post('/api/web3/metadata',headers=owner,json={**data,'media_id':None,'image_uri':'http://169.254.169.254/credentials'}).status_code==422
    response=client.post('/api/web3/metadata',headers=owner,json=data)
    assert response.status_code==200,response.text
    record=response.json()
    cid=record['uri'].removeprefix('ipfs://')
    raw=httpx.post(svc.config.ipfs_api_url+'/api/v0/cat',params={'arg':cid},timeout=10).content
    assert svc.canonical(json.loads(raw))[1]==record['sha256']
    assert client.post('/api/web3/metadata',headers=owner,json=data).json()['id']==record['id']
    assert client.post('/api/web3/metadata',headers=owner,json={**data,'name':'Mutated'}).status_code==409
    assert client.get('/api/web3/metadata',headers=other).json()==[]
    # Deleting the account clears links, intents and private metadata index (not public IPFS copies).
    link(client,owner,Account.create())
    assert client.post('/api/account/delete',headers=owner,json={'password':'native-password-123','confirmation':'DELETE'}).status_code==200

def test_real_mint_token_transfer_tips_and_receipt_integrity(client,tmp_path,monkeypatch):
    import creator
    monkeypatch.setattr(creator,'MEDIA_ROOT',tmp_path)
    headers=native_headers(client)
    w3=svc.rpc(31337)
    a=Account.create(); b=Account.create(); curator=Account.create()
    funding=w3.eth.send_transaction({'from':w3.eth.accounts[0],'to':a.address,'value':Web3.to_wei(2,'ether')})
    w3.eth.wait_for_transaction_receipt(funding)
    wallet=link(client,headers,a)
    upload=client.post('/api/creator/media',headers={**headers,'content-type':'image/png'},content=PNG).json()
    meta=client.post('/api/web3/metadata',headers=headers,json={'request_id':str(uuid.uuid4()),'name':'Integration collectible','description':'Generated local fixture','media_id':upload['id'],'public_storage_consent':True}).json()
    nft=prepare(client,headers,wallet,'mint_nft',metadata_id=meta['id'],royalty_bps=500)
    # An unrelated successful transaction must never turn into a mint.
    mismatch=client.post(f"/api/web3/intents/{nft['id']}/submit",headers=headers,json={'tx_hash':Web3.to_hex(funding)})
    assert mismatch.status_code==422,mismatch.text
    confirmed=submit(client,headers,nft,send(w3,a,nft))
    assert confirmed['status']=='confirmed'
    token_id=confirmed['result']['token_id']
    state=client.get(f"/api/web3/wallets/{wallet['id']}/balances",headers=headers).json()
    assert state['collectibles'][0]['token_id']==token_id
    assert state['collectibles'][0]['uri']==meta['uri']
    duplicate=prepare(client,headers,wallet,'mint_nft',metadata_id=meta['id'])
    assert client.post(f"/api/web3/intents/{duplicate['id']}/submit",headers=headers,json={'tx_hash':confirmed['tx_hash']}).status_code==409
    transfer=prepare(client,headers,wallet,'send_nft',token_id=token_id,recipient=b.address)
    assert submit(client,headers,transfer,send(w3,a,transfer))['status']=='confirmed'
    assert client.get(f"/api/web3/wallets/{wallet['id']}/balances",headers=headers).json()['collectibles']==[]
    token=prepare(client,headers,wallet,'create_token',metadata_id=meta['id'],symbol='STUD',supply='1000')
    token_result=submit(client,headers,token,send(w3,a,token))
    assert token_result['status']=='confirmed'
    addr=token_result['result']['token_address']
    payment=prepare(client,headers,wallet,'send_token',token_address=addr,recipient=b.address,amount='2.5')
    assert submit(client,headers,payment,send(w3,a,payment))['status']=='confirmed'
    balance=client.get(f"/api/web3/wallets/{wallet['id']}/balances",headers=headers).json()
    assert balance['tokens'][0]['balance']==str(9975*10**17)
    tip=prepare(client,headers,wallet,'tip',recipient=b.address,amount='0.01',curator=curator.address,curator_bps=1000)
    assert submit(client,headers,tip,send(w3,a,tip))['status']=='confirmed'
    assert w3.eth.get_balance(b.address)==9*10**15
    assert w3.eth.get_balance(curator.address)==10**15
    native=prepare(client,headers,wallet,'send_native',recipient=b.address,amount='0.001')
    assert submit(client,headers,native,send(w3,a,native))['status']=='confirmed'
    assert w3.eth.get_balance(b.address)==10**16
    # Code tampering in the deployment registry fails closed.
    original=svc.registry
    monkeypatch.setattr(svc,'registry',lambda chain:{**original(chain),'collectibles':{'address':state['collectibles'][0]['contract'],'code_hash':'0x00'}})
    result=client.post('/api/web3/intents',headers=headers,json={'request_id':str(uuid.uuid4()),'wallet_id':wallet['id'],'kind':'mint_nft','metadata_id':meta['id']})
    assert result.status_code==503,result.text


def test_unverified_hash_cannot_block_its_owner_and_confirmation_threshold_is_respected(client,monkeypatch):
    w3=svc.rpc(31337)
    owner=native_headers(client)
    attacker=native_headers(client,'hash-squatter@example.com')
    a,b=Account.create(),Account.create()
    for account in (a,b):
        w3.eth.wait_for_transaction_receipt(w3.eth.send_transaction({'from':w3.eth.accounts[0],'to':account.address,'value':10**18}))
    wa,wb=link(client,owner,a),link(client,attacker,b)
    intended=prepare(client,owner,wa,'send_native',recipient=b.address,amount='0.001')
    malicious=prepare(client,attacker,wb,'send_native',recipient=a.address,amount='0.001')
    tx={**intended['transaction'],'nonce':w3.eth.get_transaction_count(a.address),'gasPrice':w3.eth.gas_price}
    for k in ('chainId','gas','value'):tx[k]=int(tx[k],16)
    tx.pop('from')
    signed=a.sign_transaction(tx)
    future_hash=Web3.to_hex(signed.hash)
    assert submit(client,attacker,malicious,future_hash)['status']=='submitted'
    w3.eth.wait_for_transaction_receipt(w3.eth.send_raw_transaction(signed.raw_transaction))
    original=svc.chain_info
    monkeypatch.setattr(svc,'chain_info',lambda cid:{**original(cid),'confirmations':2})
    assert submit(client,owner,intended,future_hash)['status']=='pending'
    w3.provider.make_request('evm_mine',[])
    assert submit(client,owner,intended,future_hash)['status']=='confirmed'
    assert client.post(f"/api/web3/intents/{malicious['id']}/submit",headers=attacker,json={'tx_hash':future_hash}).status_code==409
    # Offline storage is insufficient for public-network mints; no public RPC is called.
    public=link(client,owner,a,84532)
    result=client.post('/api/web3/intents',headers=owner,json={'request_id':str(uuid.uuid4()),'wallet_id':public['id'],'kind':'mint_nft','metadata_id':str(uuid.uuid4())})
    assert result.status_code==503,result.text


def test_reverted_transaction_is_never_credited(client):
    w3=svc.rpc(31337)
    headers=native_headers(client)
    a,recipient=Account.create(),Account.create()
    w3.eth.wait_for_transaction_receipt(w3.eth.send_transaction({'from':w3.eth.accounts[0],'to':a.address,'value':10**18}))
    wallet=link(client,headers,a)
    intended=prepare(client,headers,wallet,'send_native',recipient=recipient.address,amount='0.001')
    # Change the recipient to a reverting contract after simulation, modeling a
    # state change between preparation and mining on the disposable local chain.
    w3.provider.make_request('hardhat_setCode',[recipient.address,'0x60006000fd'])
    w3.provider.make_request('evm_setAutomine',[False])
    try:
        tx={**intended['transaction'],'nonce':w3.eth.get_transaction_count(a.address),'gasPrice':w3.eth.gas_price}
        for k in ('chainId','gas','value'):tx[k]=int(tx[k],16)
        tx.pop('from')
        tx_hash=Web3.to_hex(w3.eth.send_raw_transaction(a.sign_transaction(tx).raw_transaction))
        w3.provider.make_request('evm_mine',[])
        assert w3.eth.get_transaction_receipt(tx_hash)['status']==0
    finally:
        w3.provider.make_request('evm_setAutomine',[True])
    assert submit(client,headers,intended,tx_hash)['status']=='reverted'
    assert w3.eth.get_balance(recipient.address)==0
