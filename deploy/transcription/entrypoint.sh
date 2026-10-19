#!/bin/sh
set -eu
enabled=$(printf '%s' "${TRANSCRIPTION_ENABLED:-false}" | tr '[:upper:]' '[:lower:]')
case "$enabled" in
  true|1|yes|on|t|y)
    # This optional image is intentionally pinned to one predownloaded model.
    # A different language/model needs its own reviewed image/configuration.
    test "${TRANSCRIPTION_MODEL:-}" = /models/ggml-tiny.en.bin || {
      echo 'Speech model path differs from the reviewed mount.' >&2; exit 1;
    }
    printf '%s  %s\n' \
      921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f \
      /models/ggml-tiny.en.bin | sha256sum --check --status || {
      echo 'Speech model missing or checksum mismatch; no download attempted.' >&2; exit 1;
    }
    ;;
esac
exec "$@"
