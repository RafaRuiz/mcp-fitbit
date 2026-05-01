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
  echo "[entrypoint] Visit https://<your-public-url>/auth from any browser"
  echo "[entrypoint] to complete the OAuth flow. The token will be saved here."
fi

ln -sfn /data/.fitbit-token.json /app/.fitbit-token.json

# Persistent OAuth: keep the /auth and /callback routes available across the
# container's lifetime so the user can re-auth from a browser at any time
# without restarting the container. See src/auth.ts.
export OAUTH_PERSISTENT=true

# auth-proxy is the only top-level process; it spawns supergateway as a child.
exec node /app/proxy/auth-proxy.mjs
