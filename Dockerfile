# syntax=docker/dockerfile:1
# ---------- Build stage ----------
FROM node:20-alpine AS builder

WORKDIR /build

# Cache npm install on package files alone
COPY package.json package-lock.json ./
RUN npm ci

# Compile TS → build/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- Runtime stage ----------
FROM node:20-alpine AS runtime

# tini for signal handling, mcp-proxy for stdio→SSE bridge.
#
# Why mcp-proxy and not supergateway: supergateway shares ONE stdio child
# across every inbound SSE client, but the MCP SDK's stdio transport is
# strictly single-client — the second client to connect crashes the bridge
# with "Already connected to a transport". claude.ai legitimately opens
# multiple SSE connections during a session (initialise on one, then
# reconnect for the persistent stream), which made supergateway unusable.
# mcp-proxy spawns a fresh stdio child per SSE connection so each client
# gets its own MCP process.
RUN apk add --no-cache tini wget \
    && npm install -g mcp-proxy

WORKDIR /app

# MCP server runtime: prod deps + compiled output
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /build/build ./build

# Auth proxy (ESM module, isolated deps)
COPY docker/proxy/package.json ./proxy/
RUN cd proxy && npm install --omit=dev
COPY docker/proxy/auth-proxy.mjs ./proxy/

# Entrypoint: symlinks token file to persistent volume, then exec proxy
COPY docker/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENV PORT=8000
ENV BRIDGE_PORT=8001
EXPOSE 8000

# CapRover hits /health to detect zombie containers; route is unauthenticated.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/entrypoint.sh"]
