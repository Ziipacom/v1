"""Offline inference host checks. Never emits secret values or calls providers."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import platform
import re
import shutil
import sys

from preflight import capture, validate_image, validate_secret_file

KEYS = frozenset({'ZIIPA_INFERENCE_API_KEY', 'ZIIPA_INFERENCE_MODEL'})


def parse_environment(contents):
    if len(contents.encode('utf-8')) > 2048 or '\x00' in contents:
        raise ValueError('Invalid inference environment')
    values = {}
    for line in contents.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or key not in KEYS or key in values or value != value.strip():
            raise ValueError('Use only the two inference settings, once each')
        values[key] = value
    if set(values) != KEYS or not re.fullmatch(r'[A-Za-z0-9_-]{32,256}', values['ZIIPA_INFERENCE_API_KEY']):
        raise ValueError('A random, URL-safe private gateway key is required')
    if ('replace-' in values['ZIIPA_INFERENCE_API_KEY'].lower()
            or not re.fullmatch(r'[A-Za-z0-9_.:/-]{1,120}', values['ZIIPA_INFERENCE_MODEL'])
            or 'cloud' in values['ZIIPA_INFERENCE_MODEL'].lower()):
        raise ValueError('Replace the example and choose a downloaded model')
    return values


def validate_resources(meminfo, free_bytes, cpu_count, small_host=False):
    # The existing 1 GiB renderer and 512 MiB workflows must coexist with 2 GiB
    # Ollama, gateway, optional tunnel, OS and image builds without host OOM.
    match = re.search(r'^MemTotal:\s+(\d+) kB$', meminfo, re.MULTILINE)
    minimum_kb, minimum_cpus = (3840 * 1024, 1) if small_host else (7 * 1024 * 1024, 2)
    if not match or int(match.group(1)) < minimum_kb or cpu_count < minimum_cpus:
        raise ValueError('Use a native host with enough verified free capacity for the selected inference profile')
    if free_bytes < 6 * 1024**3:
        raise ValueError('Reserve at least 6 GiB on the existing disk for model/images; do not add paid disks')


def validate_model_manifest(contents):
    if len(contents.encode('utf-8')) > 16384:
        raise ValueError('The local model manifest is too large')
    manifest = json.loads(contents)
    layers = manifest.get('layers', [])
    if not layers or len(layers) > 100 or not all(isinstance(layer, dict) and isinstance(layer.get('size'), int)
                             and layer['size'] > 0 and re.fullmatch(r'sha256:[a-f0-9]{64}', layer.get('digest', ''))
                             for layer in layers):
        raise ValueError('A downloaded local model manifest is required')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env-file', type=Path, default=Path('/etc/ziipa/inference-gateway.env'))
    parser.add_argument('--tunnel', action='store_true')
    parser.add_argument('--small-host', action='store_true', help='Explicit bounded 0.6b demo profile, not unrestricted launch capacity')
    args = parser.parse_args()
    try:
        if platform.system() != 'Linux' or platform.machine().lower() not in {'arm64', 'aarch64'}:
            raise ValueError('Native ARM64 acceptance is required')
        validate_secret_file(args.env_file)
        settings = parse_environment(args.env_file.read_text(encoding='utf-8'))
        expected_model = 'qwen3:0.6b' if args.small_host else 'qwen3:1.7b'
        if settings['ZIIPA_INFERENCE_MODEL'] != expected_model:
            raise ValueError('Use only the reviewed model for the selected resource profile')
        from os import cpu_count
        validate_resources(Path('/proc/meminfo').read_text(), shutil.disk_usage('/var/lib/docker').free, cpu_count() or 0, args.small_host)
        images = ['ziipa-ollama:oracle-arm64', 'ziipa-inference:oracle-arm64']
        if args.tunnel:
            token_file = Path('/etc/ziipa/inference-tunnel.token')
            validate_secret_file(token_file)
            token = token_file.read_text(encoding='utf-8').strip()
            if not re.fullmatch(r'[A-Za-z0-9+/=_-]{80,4096}', token):
                raise ValueError('Fill only the existing approved tunnel token')
            images.append('cloudflare/cloudflared:2026.10.0')
        for image in images:
            metadata = json.loads(capture(['/usr/bin/docker', 'image', 'inspect', image]))
            if not isinstance(metadata, list) or len(metadata) != 1:
                raise ValueError('Build or pull the reviewed ARM64 image first')
            if image.startswith('cloudflare/'):
                if metadata[0].get('Os') != 'linux' or metadata[0].get('Architecture') != 'arm64':
                    raise ValueError('Use the native ARM64 tunnel image')
            else:
                validate_image(metadata[0])
        # Check actual downloaded manifest without network or secret environment.
        # Runtime authenticated readiness additionally checks Ollama's inventory;
        # a real inference+restart benchmark is mandatory operator acceptance.
        model = settings['ZIIPA_INFERENCE_MODEL']
        manifest_path = 'registry.ollama.ai/library/' + model.replace(':', '/')
        if '/' in model.split(':')[0]:
            raise ValueError('This deployment accepts the reviewed Ollama library model only')
        contents = capture(['/usr/bin/docker', 'run', '--rm', '--network', 'none', '--read-only',
                            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                            '--user', '10001:10001', '--mount', 'type=volume,source=ziipa-inference-models,target=/models,readonly',
                            '--entrypoint', '/bin/cat', 'ziipa-ollama:oracle-arm64', '/models/manifests/' + manifest_path])
        validate_model_manifest(contents)
        size = sum(layer['size'] for layer in json.loads(contents)['layers'])
        if size > (700000000 if args.small_host else 1800000000):
            raise ValueError('The actual downloaded model exceeds the selected reviewed resource profile')
    except (ValueError, OSError, TypeError, KeyError):
        print('Ziipa inference preflight failed. Check native ARM resources, reviewed images, downloaded model and separate root-only settings. No secrets were printed or providers contacted.', file=sys.stderr)
        return 1
    print('Ziipa inference offline preflight passed. Verify authenticated readiness and a real native model response before enabling the API adapter.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
