#!/bin/sh
set -eu

export IPFS_PATH="${IPFS_PATH:-/data/ipfs}"
render_port="${PORT:-10000}"

if [ ! -f "$IPFS_PATH/config" ]; then
  ipfs init --profile=server
fi

# Render exposes one private-service port. Bind only the administrative API to
# it; the gateway stays loopback-only and the API is never public.
ipfs config Addresses.API "/ip4/0.0.0.0/tcp/$render_port"
ipfs config Addresses.Gateway "/ip4/127.0.0.1/tcp/8080"

exec ipfs daemon --migrate=true
