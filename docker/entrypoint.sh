#!/bin/sh
# Container entrypoint.
#
# CapRover mounts a persistent volume at /data. The Fitbit OAuth token must
# survive container restarts/redeploys, so we symlink the path the app writes
# to (/app/.fitbit-token.json — derived from src/auth.ts) into the volume.
#
# fs.writeFile in Node follows symlinks, so refresh-token rotations land in
# /data automatically.

set -e

mkdir -p /data

if [ ! -e /data/.fitbit-token.json ]; then
  echo "[entrypoint] /data/.fitbit-token.json not found yet."
  echo "[entrypoint] Run the OAuth flow on your Mac, then SCP the resulting"
  echo "[entrypoint] .fitbit-token.json into this volume before the MCP can serve."
fi

ln -sfn /data/.fitbit-token.json /app/.fitbit-token.json

# auth-proxy is the only top-level process; it spawns supergateway as a child.
exec node /app/proxy/auth-proxy.mjs
