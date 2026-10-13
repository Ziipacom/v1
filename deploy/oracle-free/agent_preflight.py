"""Offline agent-to-gateway secret checks; no values are emitted or transmitted."""
from __future__ import annotations

import argparse
import hmac
from pathlib import Path
import re
import sys

from inference_preflight import parse_environment as gateway_environment
from preflight import validate_secret_file

KEYS = frozenset({'OS_ASSISTANT_INFERENCE_KEY', 'OS_ASSISTANT_MODEL'})


def parse_environment(contents):
    if len(contents.encode('utf-8')) > 2048 or '\x00' in contents:
        raise ValueError('Invalid agent inference environment')
    values = {}
    for line in contents.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or key not in KEYS or key in values or value != value.strip():
            raise ValueError('Use only the two supported agent inference settings, once each')
        values[key] = value
    if (set(values) != KEYS or not re.fullmatch(r'[A-Za-z0-9_-]{32,256}', values['OS_ASSISTANT_INFERENCE_KEY'])
            or values['OS_ASSISTANT_INFERENCE_KEY'].lower().startswith('replace-')
            or values['OS_ASSISTANT_MODEL'] not in {'qwen3:1.7b', 'qwen3:0.6b'}):
        raise ValueError('Use a random private gateway key and the reviewed downloaded model')
    return values


def validate_pair(agent_contents, gateway_contents, small_host=False):
    agent = parse_environment(agent_contents)
    gateway = gateway_environment(gateway_contents)
    expected = 'qwen3:0.6b' if small_host else 'qwen3:1.7b'
    if (agent['OS_ASSISTANT_MODEL'] != expected or gateway['ZIIPA_INFERENCE_MODEL'] != expected
            or not hmac.compare_digest(agent['OS_ASSISTANT_INFERENCE_KEY'], gateway['ZIIPA_INFERENCE_API_KEY'])):
        raise ValueError('The agent and selected gateway profile must use the same private key and model')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--agent-env-file', type=Path, default=Path('/etc/ziipa/agent-inference.env'))
    parser.add_argument('--gateway-env-file', type=Path, default=Path('/etc/ziipa/inference-gateway.env'))
    parser.add_argument('--small-host', action='store_true')
    args = parser.parse_args()
    try:
        validate_secret_file(args.agent_env_file)
        validate_secret_file(args.gateway_env_file)
        validate_pair(args.agent_env_file.read_text(encoding='utf-8'), args.gateway_env_file.read_text(encoding='utf-8'), args.small_host)
    except (ValueError, OSError, TypeError, KeyError):
        print('Ziipa agent inference preflight failed. Check both separate root-only files, the selected profile model and matching private gateway key. No credentials were printed or providers contacted.', file=sys.stderr)
        return 1
    print('Ziipa agent inference offline preflight passed. Runtime still requires downloaded model and worker readiness.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
