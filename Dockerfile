# syntax=docker/dockerfile:1
# ---------- Build stage ----------
FROM node:22-alpine AS builder

WORKDIR /build

# Cache npm install on package files alone
COPY package.json package-lock.json ./
RUN npm ci

# Compile TS → build/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- Runtime stage ----------
FROM node:22-alpine AS runtime

# tini for signal handling (graceful shutdown flushes the OAuth store)
RUN apk add --no-cache tini wget

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /build/build ./build

# The server speaks HTTP itself (OAuth + Streamable HTTP MCP at /mcp).
# OAuth state (registered clients, refresh tokens, Google tokens) lives in
# $DATA_DIR/store.json: mount a persistent volume at /data.
ENV NODE_ENV=production
ENV PORT=8000
ENV DATA_DIR=/data
EXPOSE 8000

# CapRover hits /health to detect zombie containers; route is unauthenticated.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "build/index.js"]
