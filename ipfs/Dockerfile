FROM ipfs/kubo:v0.43.0

ENV IPFS_TELEMETRY=off

COPY --chmod=755 start-render.sh /usr/local/bin/start-render-ipfs

ENTRYPOINT ["/usr/local/bin/start-render-ipfs"]
