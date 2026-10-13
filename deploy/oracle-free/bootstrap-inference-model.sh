#!/bin/sh
# Operator-only reviewed download. No provider credentials or published ports.
set -eu
case "${1:-}" in
  normal) model='qwen3:1.7b'; memory='2g' ;;
  small) model='qwen3:0.6b'; memory='1g' ;;
  *) echo 'Choose normal or small; stop inference before updating its model.' >&2; exit 2 ;;
esac
docker run --rm --network bridge --read-only --user 10001:10001 -e OLLAMA_HOST=127.0.0.1:11434 \
  --cpus 0.75 --memory "$memory" --memory-swap "$memory" --pids-limit 128 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=67108864,mode=1777 \
  --tmpfs /home/ollama:rw,noexec,nosuid,nodev,size=1048576,uid=10001,gid=10001,mode=0700 \
  --mount type=volume,source=ziipa-inference-models,target=/models \
  --entrypoint /bin/sh ziipa-ollama:oracle-arm64 -c '
    set -eu
    ollama serve >/tmp/ollama-bootstrap.log 2>&1 & server=$!
    trap "kill $server 2>/dev/null || true" EXIT HUP INT TERM
    attempts=0
    until ollama list >/dev/null 2>&1; do
      attempts=$((attempts + 1)); test "$attempts" -lt 30; sleep 1
    done
    ollama pull "$1"
    ollama list
  ' ziipa-bootstrap "$model"
