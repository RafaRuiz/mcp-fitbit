// Bearer-auth wrapper around mcp-proxy + OAuth passthrough.
//
// Layout:
//   claude.ai ──HTTPS──▶ CapRover NGINX ──HTTP──▶ this proxy (8000)
//                                                       │
//                          ┌─── /health ────── (no auth) returns "ok"
//                          ├─── /auth, /callback ── (no auth) ──▶ MCP OAuth (3000)
//                          └─── everything else ─── (Bearer) ──▶ mcp-proxy (8001) ──stdio──▶ MCP server (fresh per SSE)
//
// Why we exist:
//   1. Bearer-token auth so the public endpoint isn't open.
//   2. /health for CapRover to poll.
//   3. /auth + /callback unauthenticated so the user can complete the Fitbit
//      OAuth flow from any browser (their phone, etc) without needing access
//      to the host that runs the server.
//
// mcp-proxy is spawned as a child so this proxy is the only top-level node
// process — when mcp-proxy dies we exit and CapRover restarts the container.
// (We tried supergateway first; it shares one stdio child across all SSE
// clients and the MCP SDK rejects the second connection. mcp-proxy spawns a
// fresh child per SSE connection, which is what claude.ai needs.)

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { spawn } from 'node:child_process';

const PORT = parseInt(process.env.PORT || '8000', 10);
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '8001', 10);
const OAUTH_PORT = parseInt(process.env.OAUTH_PORT || '3000', 10);
const TOKEN = process.env.MCP_BEARER_TOKEN;
const MCP_COMMAND = process.env.MCP_COMMAND || 'node /app/build/index.js';

if (!TOKEN) {
  console.error('FATAL: MCP_BEARER_TOKEN must be set');
  process.exit(1);
}

// ---- Spawn mcp-proxy as a child ------------------------------------------
// `--server sse` selects only the legacy SSE transport (claude.ai's BETA
// connector UI uses SSE). `--shell` lets the inner command be a single
// string. mcp-proxy spawns one stdio child per inbound SSE connection.
const mcpCommandParts = MCP_COMMAND.split(/\s+/).filter(Boolean);
const sg = spawn(
  'mcp-proxy',
  [
    '--port',
    String(BRIDGE_PORT),
    '--server',
    'sse',
    '--sseEndpoint',
    '/sse',
    '--',
    ...mcpCommandParts,
  ],
  { stdio: 'inherit', shell: false }
);

sg.on('exit', (code, signal) => {
  console.error(`mcp-proxy exited (code=${code} signal=${signal}); shutting down`);
  process.exit(code ?? 1);
});

const forward = (sig) => () => {
  if (!sg.killed) sg.kill(sig);
};
process.on('SIGTERM', forward('SIGTERM'));
process.on('SIGINT', forward('SIGINT'));

// ---- Express + auth + SSE-friendly proxy ---------------------------------
const app = express();
app.disable('etag');
app.disable('x-powered-by');

// Health check — public, no auth required (CapRover polls it).
app.get('/health', (_req, res) => {
  res.type('text/plain').send('ok');
});

// OAuth flow — public, no Bearer required. Forwarded to the MCP server's
// internal OAuth express server (port OAUTH_PORT). The user's browser hits
// /auth on the public URL → Fitbit consent → /callback on the public URL →
// token persisted to /data on the volume by the MCP itself.
const oauthProxy = createProxyMiddleware({
  target: `http://127.0.0.1:${OAUTH_PORT}`,
  changeOrigin: true,
  xfwd: true,
  on: {
    error: (err, _req, res) => {
      console.error('oauth proxy error:', err.message);
      if (res && !res.headersSent && typeof res.status === 'function') {
        res
          .status(502)
          .type('text/plain')
          .send(
            'OAuth server unavailable. Check that OAUTH_PERSISTENT=true and that the MCP process is running.\n'
          );
      }
    },
  },
});
// IMPORTANT: use `app.all` (not `app.use('/path', ...)`) so Express does NOT
// strip the `/auth` or `/callback` prefix before handing the request to the
// proxy. The upstream MCP OAuth server registers exact routes at /auth and
// /callback — without the prefix it would return 404.
app.all('/auth', oauthProxy);
app.all('/callback', oauthProxy);

// Authenticated SSE sessions. The MCP-over-SSE handshake is two-step:
//
//   1. Client opens `GET /sse` (with auth). supergateway emits an SSE event
//      `event: endpoint` whose data is a relative URL like
//      `/message?sessionId=<uuid>`.
//   2. Client POSTs to `/message?sessionId=<uuid>` for every JSON-RPC call.
//
// Step 2 carries the sessionId but NOT the original auth — when claude.ai
// resolves the relative `/message?sessionId=...` URL against the base
// (which might have had `?token=...`), the absolute path replaces the
// query string and the token is dropped.
//
// Workaround: when a step-1 request authenticates successfully, we peek
// at the SSE response to learn the sessionId supergateway generated, and
// remember it. Step-2 calls are then authorised by sessionId membership.
const authedSessions = new Set();
const SESSION_ID_RE = /sessionId=([0-9a-f-]+)/i;

// Bearer gate. Accept the token via:
//   1. `Authorization: Bearer <MCP_BEARER_TOKEN>` header (preferred)
//   2. `?token=<MCP_BEARER_TOKEN>` query string (claude.ai BETA connector UI
//      has no field for custom headers, so the URL itself carries the secret)
//   3. `?sessionId=<uuid>` whose uuid is in `authedSessions` (subsequent
//      /message calls within an already-authed SSE session)
app.use((req, res, next) => {
  const fromHeader = req.headers.authorization === `Bearer ${TOKEN}`;
  const fromQuery =
    typeof req.query.token === 'string' && req.query.token === TOKEN;
  const sessionId =
    typeof req.query.sessionId === 'string' ? req.query.sessionId : null;
  const fromSession = sessionId !== null && authedSessions.has(sessionId);
  if (fromHeader || fromQuery || fromSession) return next();
  res.set('WWW-Authenticate', 'Bearer');
  res.status(401).type('text/plain').send('unauthorized\n');
});

// If the token came via query string, strip it before forwarding upstream so
// supergateway (and its stdio child) never see our shared secret.
app.use((req, _res, next) => {
  if (req.query.token !== undefined) {
    const u = new URL(req.url, 'http://internal');
    u.searchParams.delete('token');
    req.url = u.pathname + (u.search || '');
  }
  next();
});

// MCP traffic — supergateway exposes /sse, /message, etc.
// IMPORTANT: do NOT install body-parsers (express.json/etc) on this path —
// they consume the request stream and break POSTs to /message.
app.use(
  createProxyMiddleware({
    target: `http://127.0.0.1:${BRIDGE_PORT}`,
    changeOrigin: true,
    // No selfHandleResponse — let the underlying http-proxy stream as-is so
    // SSE chunks aren't buffered.
    xfwd: true,
    on: {
      proxyReq: (proxyReq) => {
        // Strip our internal Authorization header from the upstream call.
        // supergateway doesn't need it and shouldn't see our shared secret.
        proxyReq.removeHeader('authorization');
      },
      proxyRes: (proxyRes, req) => {
        // For /sse responses, peek at the streamed chunks to learn the
        // sessionId supergateway emits in the `event: endpoint` data line.
        // That sessionId then authorises subsequent /message?sessionId=...
        // POSTs from the same client (see the bearer gate above).
        //
        // We attach a 'data' listener WITHOUT consuming the stream — the
        // default piping to the client continues normally, we just observe.
        if (!req.url || !req.url.startsWith('/sse')) return;
        let observed = '';
        proxyRes.on('data', (chunk) => {
          if (observed.length > 4096) return; // cap memory
          observed += chunk.toString('utf8');
          const match = observed.match(SESSION_ID_RE);
          if (match) {
            const id = match[1];
            if (!authedSessions.has(id)) {
              authedSessions.add(id);
              console.log(`[auth-proxy] sse session authed: ${id}`);
            }
            observed = ''; // got it, stop accumulating
          }
        });
      },
      error: (err, _req, res) => {
        console.error('proxy error:', err.message);
        if (res && !res.headersSent && typeof res.status === 'function') {
          res.status(502).type('text/plain').send('upstream error\n');
        }
      },
    },
  })
);

const server = app.listen(PORT, () => {
  console.log(
    `auth-proxy listening on :${PORT} → mcp-proxy :${BRIDGE_PORT}, oauth :${OAUTH_PORT}`
  );
});

// SSE connections are long-lived. Disable Node's default request/keep-alive
// timeouts so claude.ai's stream doesn't get killed mid-session.
server.setTimeout(0);
server.keepAliveTimeout = 0;
server.headersTimeout = 0;
