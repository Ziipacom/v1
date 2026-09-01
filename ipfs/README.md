# Ziipa private IPFS service

Render builds this small wrapper around the pinned Kubo image. It initializes a
server-profile repository on the attached persistent disk and exposes the Kubo
API only on Render's private network. The public HTTP gateway remains disabled.

`IPFS_PUBLIC` must stay `false` until operators verify public peer reachability,
replication, moderation, retention, backup, and independent resolution of each
CID. The service never stores wallet keys.
