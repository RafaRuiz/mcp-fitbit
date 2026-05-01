// Bearer-auth wrapper around supergateway.
//
// Layout:
//   claude.ai ──HTTPS──▶ CapRover NGINX ──HTTP──▶ this proxy (8000) ──▶ supergateway (8001) ──stdio──▶ MCP server
//
// Why we exist: the underlying MCP server is single-user stdio. supergateway
// turns it into SSE; we add (a) Bearer-token auth so the public endpoint isn't
// open and (b) a /health route CapRover can poll. supergateway is spawned as a
// child process so this proxy is the only top-level node process — when
// supergateway dies, we exit and CapRover restarts the container.

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { spawn } from 'node:child_process';

const PORT = parseInt(process.env.PORT || '8000', 10);
const SUPERGATEWAY_PORT = parseInt(process.env.SUPERGATEWAY_PORT || '8001', 10);
const TOKEN = process.env.MCP_BEARER_TOKEN;
const MCP_COMMAND = process.env.MCP_COMMAND || 'node /app/build/index.js';

if (!TOKEN) {
  console.error('FATAL: MCP_BEARER_TOKEN must be set');
  process.exit(1);
}

// ---- Spawn supergateway as a child ---------------------------------------
const sg = spawn(
  'supergateway',
  ['--stdio', MCP_COMMAND, '--port', String(SUPERGATEWAY_PORT)],
  { stdio: 'inherit', shell: false }
);

sg.on('exit', (code, signal) => {
  console.error(`supergateway exited (code=${code} signal=${signal}); shutting down`);
  process.exit(code ?? 1);
});

const forward = (sig) => () => {
  if (!sg.killed) sg.kill(sig);
};
process.on('SIGTERM', forward('SIGTERM'));
process.on('SIGINT', forward('SIGINT'));

// ---- Express + bearer + SSE-friendly proxy --------------------------------
const app = express();
app.disable('etag');
app.disable('x-powered-by');

// Health check FIRST, before auth — CapRover needs to poll without a token.
app.get('/health', (_req, res) => {
  res.type('text/plain').send('ok');
});

// Bearer gate. Reject anything else early.
app.use((req, res, next) => {
  if (req.headers.authorization === `Bearer ${TOKEN}`) return next();
  res.set('WWW-Authenticate', 'Bearer');
  res.status(401).type('text/plain').send('unauthorized\n');
});

// Mount the proxy at root — supergateway exposes /sse, /message, etc.
// IMPORTANT: do NOT install body-parsers (express.json/etc) on this path —
// they consume the request stream and break POSTs to /message.
app.use(
  createProxyMiddleware({
    target: `http://127.0.0.1:${SUPERGATEWAY_PORT}`,
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
    `auth-proxy listening on :${PORT} → supergateway :${SUPERGATEWAY_PORT}`
  );
});

// SSE connections are long-lived. Disable Node's default request/keep-alive
// timeouts so claude.ai's stream doesn't get killed mid-session.
server.setTimeout(0);
server.keepAliveTimeout = 0;
server.headersTimeout = 0;
