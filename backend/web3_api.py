"""Authenticated testnet wallet links, consented metadata, unsigned intents, verified receipts."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Literal
from urllib.parse import urlparse
import json
import secrets
import uuid

from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from redis.exceptions import RedisError
from sqlalchemy import String, ForeignKey, DateTime, JSON, UniqueConstraint, select, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Mapped, mapped_column, Session
from web3 import Web3
from web3.exceptions import TransactionNotFound
from web3.logs import DISCARD

from app import Base, User, cache, current_user, db, guard
import creator
import web3_services as svc

router = APIRouter(prefix='/api/web3')
now = lambda: datetime.now(timezone.utc)


class WalletLink(Base):
    __tablename__ = 'web3_wallets'
    __table_args__ = (UniqueConstraint('chain_id', 'address'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    chain_id: Mapped[int]
    address: Mapped[str] = mapped_column(String(42))
    verified_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class MetadataRecord(Base):
    __tablename__ = 'web3_metadata'
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    uri: Mapped[str] = mapped_column(String(200))
    sha256: Mapped[str] = mapped_column(String(64))
    request_hash: Mapped[str] = mapped_column(String(64))
    document: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class TransactionIntent(Base):
    __tablename__ = 'web3_intents'
    __table_args__ = (UniqueConstraint('chain_id', 'tx_hash'),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    chain_id: Mapped[int]
    address: Mapped[str] = mapped_column(String(42))
    kind: Mapped[str] = mapped_column(String(24))
    request_hash: Mapped[str] = mapped_column(String(64))
    transaction: Mapped[dict] = mapped_column(JSON)
    summary: Mapped[dict] = mapped_column(JSON)
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    tx_hash: Mapped[str | None] = mapped_column(String(66), nullable=True)
    status: Mapped[str] = mapped_column(String(24), default='prepared')
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class LinkInput(BaseModel):
    chain_id: int
    address: str = Field(max_length=42)


class ProofInput(BaseModel):
    challenge_id: uuid.UUID
    signature: str = Field(pattern=r'^0x[0-9a-fA-F]{130}$')


class MetadataInput(BaseModel):
    request_id: uuid.UUID
    name: str = Field(min_length=1, max_length=80, pattern=r'.*\S.*')
    description: str = Field(default='', max_length=2000)
    media_id: uuid.UUID | None = None
    image_uri: str = Field(default='', max_length=200)
    attributes: dict[str, str] = Field(default_factory=dict, max_length=20)
    public_storage_consent: Literal[True]


class IntentInput(BaseModel):
    request_id: uuid.UUID
    wallet_id: uuid.UUID
    kind: Literal['mint_nft', 'create_token', 'tip', 'send_native', 'send_token', 'send_nft']
    metadata_id: uuid.UUID | None = None
    royalty_bps: int = Field(default=0, ge=0, le=1000)
    symbol: str = Field(default='', max_length=10, pattern=r'^[A-Z0-9]*$')
    supply: str = Field(default='1000000', pattern=r'^[1-9][0-9]{0,9}$')
    recipient: str = Field(default='', max_length=42)
    amount: str = Field(default='0', pattern=r'^(0|[1-9][0-9]{0,9})(\.[0-9]{1,18})?$')
    curator: str = Field(default='', max_length=42)
    curator_bps: int = Field(default=0, ge=0, le=5000)
    token_address: str = Field(default='', max_length=42)
    token_id: str = Field(default='0', pattern=r'^[0-9]{1,78}$')


class SubmitInput(BaseModel):
    tx_hash: str = Field(pattern=r'^0x[0-9a-fA-F]{64}$')


def owned(session, model, record_id, user):
    row = session.get(model, str(record_id))
    if not row or row.owner_id != user.id:
        raise HTTPException(404, 'Record not found')
    return row


def wallet_json(row):
    return dict(id=row.id, chain_id=row.chain_id, address=row.address, verified_at=row.verified_at.isoformat())


def metadata_json(row):
    return dict(id=row.id, uri=row.uri, sha256=row.sha256, document=row.document, public=svc.config.ipfs_public)


def intent_json(row):
    return dict(id=row.id, kind=row.kind, chain_id=row.chain_id, transaction=row.transaction, summary=row.summary,
                status=row.status, tx_hash=row.tx_hash or row.result.get('unverified_tx_hash'), result=row.result, created_at=row.created_at.isoformat())


@router.get('/config')
def configuration():
    storage = ('public_ipfs' if svc.config.ipfs_public else
               'pinata_ipfs' if svc.config.pinata_jwt else 'local_ipfs')
    return {'testnet_only': True, 'storage': storage,
            'chains': [{**c, 'deployed': all(k in svc.registry(c['id']) for k in ('collectibles','factory','tips')),
                        'contracts': {k:v['address'] for k,v in svc.registry(c['id']).items()}} for c in svc.chains()],
            'wallet_types': ['EVM externally owned accounts'], 'inventory_scope':'Ziipa collection and tracked factory tokens'}


@router.post('/challenge', dependencies=[Depends(guard)])
def challenge(data: LinkInput, user: User = Depends(current_user)):
    svc.chain_info(data.chain_id)
    addr = svc.address(data.address)
    origin = svc.config.web3_public_origin.rstrip('/')
    domain = urlparse(origin).netloc
    nonce = secrets.token_hex(16)
    issued = now()
    message = (f'{domain} wants you to sign in with your Ethereum account:\n{addr}\n\n'
               f'Link this wallet to your Ziipa account {user.id}. No transaction or spending permission.\n\n'
               f'URI: {origin}\nVersion: 1\nChain ID: {data.chain_id}\nNonce: {nonce}\n'
               f'Issued At: {issued.isoformat()}\nExpiration Time: {(issued + timedelta(minutes=5)).isoformat()}')
    key = str(uuid.uuid4())
    try:
        cache.setex('web3_challenge:' + key, 300, json.dumps(dict(owner=user.id, chain=data.chain_id, address=addr, message=message)))
    except RedisError:
        raise HTTPException(503, 'Wallet verification service unavailable')
    return dict(id=key, message=message, expires_in=300)


@router.post('/verify', dependencies=[Depends(guard)])
def verify(data: ProofInput, user: User = Depends(current_user), session: Session = Depends(db)):
    key = 'web3_challenge:' + str(data.challenge_id)
    try:
        raw = cache.get(key)
        if not raw:
            raise HTTPException(409, 'Challenge expired or already used. Connect again.')
        saved = json.loads(raw)
        if saved['owner'] != user.id:
            raise HTTPException(403, 'Challenge belongs to another account')
        try:
            recovered = Account.recover_message(encode_defunct(text=saved['message']), signature=data.signature)
        except Exception:
            raise HTTPException(422, 'Invalid wallet signature')
        if recovered.lower() != saved['address'].lower():
            raise HTTPException(422, 'Signature does not match the selected wallet')
        consumed = cache.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, key, raw)
        if not consumed:
            raise HTTPException(409, 'Challenge already used')
    except RedisError:
        raise HTTPException(503, 'Wallet verification service unavailable')
    row = session.scalar(select(WalletLink).where(WalletLink.chain_id == saved['chain'], WalletLink.address == saved['address']))
    if row and row.owner_id != user.id:
        raise HTTPException(409, 'This wallet is already linked to another Ziipa account')
    if not row:
        if session.scalar(select(func.count()).select_from(WalletLink).where(WalletLink.owner_id == user.id)) >= 10:
            raise HTTPException(409, 'Unlink a wallet before adding another')
        row = WalletLink(owner_id=user.id, chain_id=saved['chain'], address=saved['address'])
        session.add(row)
    row.verified_at = now()
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(409, 'Wallet link changed. Connect again.')
    return wallet_json(row)


@router.get('/wallets')
def wallets(user: User = Depends(current_user), session: Session = Depends(db)):
    return [wallet_json(r) for r in session.scalars(select(WalletLink).where(WalletLink.owner_id == user.id))]


@router.post('/wallets/{wallet_id}/unlink', dependencies=[Depends(guard)])
def unlink(wallet_id: uuid.UUID, user: User = Depends(current_user), session: Session = Depends(db)):
    session.delete(owned(session, WalletLink, wallet_id, user))
    session.commit()
    return {'ok':True}


@router.post('/metadata', dependencies=[Depends(guard)])
def metadata(data: MetadataInput, user: User = Depends(current_user), session: Session = Depends(db)):
    request_hash = svc.canonical(data.model_dump(mode='json'))[1]
    previous = session.get(MetadataRecord, str(data.request_id))
    if previous:
        if previous.owner_id != user.id or previous.request_hash != request_hash:
            raise HTTPException(409, 'Metadata request ID already used with different content')
        return metadata_json(previous)
    # Serialize per-account storage requests and account deletion, with a finite quota.
    session.execute(select(User).where(User.id == user.id).with_for_update())
    if session.scalar(select(func.count()).select_from(MetadataRecord).where(MetadataRecord.owner_id == user.id)) >= 100:
        raise HTTPException(409, 'Local metadata quota reached (100 records).')
    if any(len(k) > 50 or len(v) > 200 for k,v in data.attributes.items()):
        raise HTTPException(422, 'Metadata traits are too long')
    media_type = 'image'
    if data.media_id:
        media = owned(session, creator.CreatorMedia, data.media_id, user)
        from storage_services import LocalStorage, storage
        provider = storage()
        if isinstance(provider, LocalStorage):
            path = creator.MEDIA_ROOT / str(data.media_id)
            if not path.is_file():
                raise HTTPException(404, 'Upload file no longer available')
            media_bytes = path.read_bytes()
        else:
            media_bytes = provider.read_bytes(user.id, str(data.media_id))
        if len(media_bytes) > 100 * 1024 * 1024:
            raise HTTPException(413, 'NFT media is too large for the configured pinning workflow.')
        uri = svc.pin(media_bytes, media.id)
        media_type = media.content_type.split('/')[0]
    elif data.image_uri:
        uri = svc.content_uri(data.image_uri)
    else:
        raise HTTPException(422, 'Choose an uploaded file or an existing IPFS media URI')
    document = {'name':data.name.strip(), 'description':data.description, 'attributes':[{'trait_type':k,'value':v} for k,v in data.attributes.items()]}
    document['image' if media_type == 'image' else 'animation_url'] = uri
    raw, digest = svc.canonical(document)
    row = MetadataRecord(id=str(data.request_id), owner_id=user.id, uri=svc.pin(raw,'metadata.json'), sha256=digest, request_hash=request_hash, document=document)
    session.add(row)
    session.commit()
    return metadata_json(row)


@router.get('/metadata')
def metadata_list(user: User = Depends(current_user), session: Session = Depends(db)):
    return [metadata_json(r) for r in session.scalars(select(MetadataRecord).where(MetadataRecord.owner_id == user.id).order_by(MetadataRecord.created_at.desc()).limit(100))]


def token_contract(w3, chain_id, token_address):
    addr = svc.address(token_address)
    factory = svc.contract(w3, chain_id, 'factory')
    if not factory.functions.isCreatorToken(addr).call():
        raise HTTPException(422, 'Only tokens issued by the configured Ziipa factory are supported')
    return w3.eth.contract(address=addr, abi=svc.abi('ZiipaCreatorToken'))


def build_intent(data, wallet, user, session, w3):
    chain_id, sender = wallet.chain_id, wallet.address
    summary = {'network':svc.chain_info(chain_id)['name'], 'sender':sender}
    tx = {'from':sender, 'chainId':hex(chain_id), 'value':'0x0', 'data':'0x'}
    if data.kind in ('mint_nft','create_token'):
        meta = owned(session, MetadataRecord, data.metadata_id, user)
        summary.update(name=meta.document['name'], metadata_uri=meta.uri, metadata_sha256=meta.sha256)
        if data.kind == 'mint_nft':
            c = svc.contract(w3, chain_id, 'collectibles')
            fn = c.functions.mint(meta.uri, data.royalty_bps)
            summary['royalty_bps'] = data.royalty_bps
        else:
            if not data.symbol or int(data.supply) > 1_000_000_000:
                raise HTTPException(422, 'Provide a symbol and a fixed supply up to 1 billion')
            c = svc.contract(w3, chain_id, 'factory')
            fn = c.functions.createToken(meta.document['name'], data.symbol, int(data.supply)*10**18, meta.uri)
            summary.update(symbol=data.symbol, supply=data.supply)
        tx.update(to=c.address, data=fn._encode_transaction_data())
    else:
        recipient = svc.address(data.recipient)
        summary['recipient'] = recipient
        if data.kind == 'send_nft':
            c = svc.contract(w3, chain_id, 'collectibles')
            token_id = int(data.token_id)
            if token_id >= 2**256 or c.functions.ownerOf(token_id).call().lower() != sender.lower():
                raise HTTPException(422, 'The selected wallet does not own this collectible')
            fn = c.functions.safeTransferFrom(sender, recipient, token_id)
            tx.update(to=c.address, data=fn._encode_transaction_data())
            summary['token_id'] = data.token_id
        else:
            amount = int(Decimal(data.amount) * 10**18)
            if amount <= 0:
                raise HTTPException(422, 'Amount must be greater than zero')
            summary['amount'] = data.amount
            if data.kind == 'send_token':
                c = token_contract(w3, chain_id, data.token_address)
                tx.update(to=c.address, data=c.functions.transfer(recipient,amount)._encode_transaction_data())
                summary.update(symbol=c.functions.symbol().call(), token_address=c.address)
            elif data.kind == 'tip':
                curator = svc.address(data.curator) if data.curator_bps else svc.ZERO
                c = svc.contract(w3, chain_id, 'tips')
                tx.update(to=c.address, value=hex(amount), data=c.functions.tip(recipient,curator,data.curator_bps)._encode_transaction_data())
                summary.update(curator=curator, curator_bps=data.curator_bps, symbol='ETH')
            else:
                tx.update(to=recipient, value=hex(amount))
                summary['symbol'] = 'ETH'
    estimate = w3.eth.estimate_gas({**tx, 'chainId':chain_id, 'value':int(tx['value'],16)})
    tx['gas'] = hex(estimate * 120 // 100)
    # This is an estimate, not a fixed fee quote; the wallet supplies current fee settings.
    summary['estimated_fee_wei'] = str(estimate * w3.eth.gas_price)
    return tx, summary


@router.post('/intents', dependencies=[Depends(guard)])
def prepare(data: IntentInput, user: User = Depends(current_user), session: Session = Depends(db)):
    digest = svc.canonical(data.model_dump(mode='json'))[1]
    existing = session.get(TransactionIntent, str(data.request_id))
    if existing:
        if existing.owner_id != user.id or existing.request_hash != digest:
            raise HTTPException(409, 'Transaction request ID already used with different details')
        return intent_json(existing)
    wallet = owned(session, WalletLink, data.wallet_id, user)
    if data.kind in ('mint_nft', 'create_token') and wallet.chain_id != 31337 and not (svc.config.ipfs_public or svc.config.pinata_jwt):
        raise HTTPException(503, 'Public testnet minting requires public IPFS pinning; this server is configured for offline local storage.')
    w3 = svc.rpc(wallet.chain_id)
    try:
        tx, summary = build_intent(data, wallet, user, session, w3)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(422, 'Transaction simulation failed. Check ownership, balance, recipient and test ETH for gas.')
    row = TransactionIntent(id=str(data.request_id), owner_id=user.id, chain_id=wallet.chain_id, address=wallet.address, kind=data.kind, request_hash=digest, transaction=tx, summary=summary)
    session.add(row)
    session.commit()
    return intent_json(row)


def reconcile(row, w3, tx_hash):
    tx = w3.eth.get_transaction(tx_hash)
    expected = row.transaction
    if (tx['from'].lower() != expected['from'].lower() or (tx['to'] or '').lower() != expected['to'].lower()
        or int(tx['value']) != int(expected['value'],16) or Web3.to_hex(tx['input']).lower() != expected['data'].lower()
        or int(tx.get('chainId', row.chain_id)) != row.chain_id):
        raise HTTPException(422, 'Transaction does not match this request. It was not credited.')
    row.tx_hash = tx_hash.lower()
    row.status, row.result = 'pending', {}
    try:
        receipt = w3.eth.get_transaction_receipt(tx_hash)
    except TransactionNotFound:
        return
    block = w3.eth.get_block(receipt['blockNumber'])
    if block['hash'] != receipt['blockHash']:
        return
    confirmations = max(0,w3.eth.block_number - receipt['blockNumber'] + 1)
    row.result = {'confirmations':confirmations, 'block_number':receipt['blockNumber']}
    if confirmations < svc.chain_info(row.chain_id)['confirmations']:
        return
    if receipt['status'] != 1:
        row.status = 'reverted'
        return
    if row.kind in ('mint_nft','create_token'):
        c = svc.contract(w3, row.chain_id, 'collectibles' if row.kind == 'mint_nft' else 'factory')
        event = c.events.Created() if row.kind == 'mint_nft' else c.events.TokenCreated()
        logs = [l for l in event.process_receipt(receipt, errors=DISCARD) if l['address'].lower() == c.address.lower()]
        if len(logs) != 1 or logs[0]['args']['creator'].lower() != row.address.lower() or logs[0]['args']['uri'] != row.summary['metadata_uri']:
            raise HTTPException(422, 'Expected mint event was not found. No asset was credited.')
        row.result = {**row.result, **({'token_id':str(logs[0]['args']['tokenId']), 'contract':c.address} if row.kind == 'mint_nft' else {'token_address':logs[0]['args']['token']})}
    row.status = 'confirmed'


@router.post('/intents/{intent_id}/submit', dependencies=[Depends(guard)])
def submit(intent_id: uuid.UUID, data: SubmitInput, user: User = Depends(current_user), session: Session = Depends(db)):
    row = owned(session, TransactionIntent, intent_id, user)
    if row.tx_hash and row.tx_hash.lower() != data.tx_hash.lower():
        raise HTTPException(409, 'This request already tracks a transaction; refresh its status.')
    other = session.scalar(select(TransactionIntent).where(TransactionIntent.chain_id == row.chain_id, TransactionIntent.tx_hash == data.tx_hash.lower()))
    if other and other.id != row.id:
        raise HTTPException(409, 'This transaction is already tracked')
    try:
        reconcile(row, svc.rpc(row.chain_id), data.tx_hash)
    except TransactionNotFound:
        # Persist the hash for later retry, but do not credit any asset or success.
        # Unverified hashes must not reserve the global uniqueness key: another
        # account could otherwise squat a genuine pending transaction's hash.
        row.status = 'submitted'
        row.result = {'unverified_tx_hash': data.tx_hash.lower()}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, 'Could not verify the transaction. Keep the hash and retry; do not sign again.')
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        raise HTTPException(409, 'Transaction hash is already in use')
    return intent_json(row)


@router.get('/intents')
def history(user: User = Depends(current_user), session: Session = Depends(db)):
    return [intent_json(r) for r in session.scalars(select(TransactionIntent).where(TransactionIntent.owner_id == user.id).order_by(TransactionIntent.created_at.desc()).limit(100))]


@router.get('/wallets/{wallet_id}/balances', dependencies=[Depends(guard)])
def balances(wallet_id: uuid.UUID, offset: int = Query(default=0, ge=0, le=100000), user: User = Depends(current_user), session: Session = Depends(db)):
    wallet = owned(session, WalletLink, wallet_id, user)
    w3 = svc.rpc(wallet.chain_id)
    try:
        block = w3.eth.block_number
        result = {'address':wallet.address, 'chain_id':wallet.chain_id, 'block_number':block,
                  'native_wei':str(w3.eth.get_balance(wallet.address, block)), 'collectibles':[], 'tokens':[], 'nft_total':0,
                  'scope':'Ziipa collectibles and creator tokens tracked by this account; not an index of every asset in the wallet.'}
        if svc.registry(wallet.chain_id).get('collectibles'):
            c = svc.contract(w3, wallet.chain_id, 'collectibles')
            total = c.functions.balanceOf(wallet.address).call(block_identifier=block)
            result['nft_total'] = total
            for i in range(offset, min(offset+20,total)):
                tid = c.functions.tokenOfOwnerByIndex(wallet.address,i).call(block_identifier=block)
                result['collectibles'].append({'token_id':str(tid), 'contract':c.address, 'uri':c.functions.tokenURI(tid).call(block_identifier=block)})
        rows = session.scalars(select(TransactionIntent).where(TransactionIntent.owner_id == user.id, TransactionIntent.chain_id == wallet.chain_id, TransactionIntent.kind == 'create_token', TransactionIntent.status == 'confirmed').limit(50))
        seen = set()
        for r in rows:
            addr = r.result.get('token_address')
            if not addr or addr in seen:
                continue
            seen.add(addr)
            token = token_contract(w3, wallet.chain_id, addr)
            result['tokens'].append({'address':addr, 'symbol':token.functions.symbol().call(block_identifier=block), 'decimals':18, 'balance':str(token.functions.balanceOf(wallet.address).call(block_identifier=block))})
        return result
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, 'Balance sync failed; previous balances must not be treated as current.')
