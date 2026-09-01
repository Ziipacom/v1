"""Server-side reads and encoding only. No wallet private keys or transaction signing."""
from functools import lru_cache
from pathlib import Path
import hashlib
import json
import re

import httpx
from fastapi import HTTPException
from pydantic_settings import BaseSettings, SettingsConfigDict
from web3 import Web3
from multiformats import CID

ROOT = Path(__file__).resolve().parent
ZERO = '0x0000000000000000000000000000000000000000'


class Web3Settings(BaseSettings):
    web3_enable_local: bool = False
    web3_base_rpc: str = 'https://sepolia.base.org'
    web3_sepolia_rpc: str = 'https://ethereum-sepolia-rpc.publicnode.com'
    web3_local_rpc: str = 'http://127.0.0.1:8545'
    web3_public_origin: str = 'http://localhost:8082'
    web3_registry: str = str(ROOT / '.local' / 'web3-deployments.json')
    web3_registry_json: str = ''
    ipfs_api_url: str = 'http://127.0.0.1:56001'
    ipfs_public: bool = False
    pinata_jwt: str = ''
    model_config = SettingsConfigDict(env_file='.env', extra='ignore')


config = Web3Settings()


def chains():
    result = [dict(id=84532, name='Base Sepolia', currency='ETH', explorer='https://sepolia.basescan.org', confirmations=2),
              dict(id=11155111, name='Ethereum Sepolia', currency='ETH', explorer='https://sepolia.etherscan.io', confirmations=2)]
    if config.web3_enable_local:
        result.append(dict(id=31337, name='Ziipa Local', currency='ETH', explorer='', confirmations=1))
    return result


def chain_info(chain_id):
    for c in chains():
        if c['id'] == chain_id:
            return c
    raise HTTPException(422, 'Only the configured test networks are supported. Mainnet is disabled.')


def registry(chain_id):
    chain_info(chain_id)
    try:
        document = json.loads(config.web3_registry_json) if config.web3_registry_json else json.loads(Path(config.web3_registry).read_text())
        return document[str(chain_id)]
    except (OSError, ValueError, KeyError):
        return {}


@lru_cache
def abi(name):
    return json.loads((ROOT / 'abi' / f'{name}.json').read_text())


def address(value):
    if not Web3.is_address(value) or value.lower() == ZERO:
        raise HTTPException(422, 'Enter a valid, non-zero EVM wallet address.')
    return Web3.to_checksum_address(value)


def rpc(chain_id):
    chain_info(chain_id)
    url = {84532: config.web3_base_rpc, 11155111: config.web3_sepolia_rpc, 31337: config.web3_local_rpc}[chain_id]
    w3 = Web3(Web3.HTTPProvider(url, request_kwargs={'timeout': 8}))
    try:
        if w3.eth.chain_id != chain_id:
            raise HTTPException(503, 'RPC network mismatch; transactions are disabled.')
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, 'Blockchain RPC is unavailable. No transaction was sent.')
    return w3


def contract(w3, chain_id, kind):
    row = registry(chain_id).get(kind)
    if not row:
        raise HTTPException(503, 'Ziipa contracts have not been deployed on this test network yet.')
    addr = address(row['address'])
    code = w3.eth.get_code(addr)
    if not code or Web3.to_hex(Web3.keccak(code)).lower() != row.get('code_hash', '').lower():
        raise HTTPException(503, 'Contract code does not match the deployment registry. Transactions are disabled.')
    return w3.eth.contract(address=addr, abi=abi({'collectibles':'ZiipaCollectibles', 'factory':'ZiipaTokenFactory', 'tips':'ZiipaTips'}[kind]))


def content_uri(uri):
    # Accept CIDs, never fetch a caller-controlled URL. No SSRF or credentials in metadata.
    if not re.fullmatch(r'ipfs://(?:b[a-z2-7]{20,120}|Qm[1-9A-HJ-NP-Za-km-z]{44})(?:/[A-Za-z0-9_.-]{1,80})?', uri):
        raise HTTPException(422, 'Use an ipfs:// content address or upload your own media.')
    try:
        CID.decode(uri[7:].split('/')[0])
    except (ValueError, KeyError):
        raise HTTPException(422, 'The IPFS content identifier is invalid.')
    return uri


def pin(data: bytes, filename: str):
    if config.pinata_jwt:
        try:
            response = httpx.post(
                'https://api.pinata.cloud/pinning/pinFileToIPFS',
                headers={'Authorization': f'Bearer {config.pinata_jwt}'},
                data={'pinataMetadata': json.dumps({'name': filename}),
                      'pinataOptions': json.dumps({'cidVersion': 1})},
                files={'file': (filename, data, 'application/octet-stream')},
                timeout=120, follow_redirects=False,
            )
            response.raise_for_status()
            return content_uri('ipfs://' + response.json()['IpfsHash'])
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(503, 'Pinata IPFS storage is unavailable. Nothing has been minted; retry when storage is ready.') from exc
    endpoint = config.ipfs_api_url.rstrip('/')
    if '://' not in endpoint:
        endpoint = 'http://' + endpoint
    try:
        response = httpx.post(endpoint + '/api/v0/add',
                              params={'pin':'true', 'cid-version':'1', 'raw-leaves':'true', 'wrap-with-directory':'false'},
                              files={'file':(filename, data, 'application/octet-stream')}, timeout=90, follow_redirects=False)
        response.raise_for_status()
        cid = response.json()['Hash']
        return content_uri('ipfs://' + cid)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, 'IPFS storage is unavailable. Nothing has been minted; retry storage when the service is ready.')


def canonical(document):
    raw = json.dumps(document, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()
    return raw, hashlib.sha256(raw).hexdigest()
