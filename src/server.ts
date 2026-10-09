/**
 * HTTP application: OAuth endpoints (via the MCP SDK router), the Google
 * callback, and the stateless Streamable HTTP MCP endpoint at /mcp.
 */

import express, { type Express, type RequestHandler } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { type AppConfig, MCP_SCOPES } from './config.js';
import {
  createHealthApi,
  type GetToken,
  type HealthApi,
} from './google/client.js';
import { createMcpServer } from './mcp.js';
import { type GoogleOAuthClient, GoogleTokenService } from './oauth/google.js';
import { HealthOAuthProvider } from './oauth/provider.js';
import type { JsonStore } from './oauth/store.js';
import { homePage, privacyPage } from './pages.js';

export interface AppDependencies {
  config: AppConfig;
  store: JsonStore;
  google: GoogleOAuthClient;
  tokens?: GoogleTokenService;
  /** Override the Google Health API client (tests) */
  healthApi?: HealthApi;
  now?: () => number;
}

/**
 * Accepts client_secret_basic on the token/revocation endpoints by copying
 * the Basic credentials into the form body, which is what the SDK reads.
 */
const clientSecretBasic: RequestHandler[] = [
  express.urlencoded({ extended: false }),
  (req, _res, next) => {
    const header = req.headers.authorization;
    if (header?.startsWith('Basic ') && req.body && !req.body.client_id) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator > 0) {
        req.body.client_id = decodeURIComponent(decoded.slice(0, separator));
        req.body.client_secret = decodeURIComponent(
          decoded.slice(separator + 1)
        );
      }
    }
    next();
  },
];

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: '2.0',
  error: { code, message },
  id: null,
});

export function createApp(deps: AppDependencies): Express {
  const { config, store, google } = deps;
  const tokens = deps.tokens ?? new GoogleTokenService(store, google, deps.now);
  const provider = new HealthOAuthProvider({
    config,
    store,
    google,
    tokens,
    now: deps.now,
  });

  const getToken: GetToken = async (extra, options) => {
    const userId = extra.authInfo?.extra?.userId;
    if (typeof userId !== 'string') {
      throw new Error('Request is not associated with a signed-in user');
    }
    return tokens.getAccessToken(userId, options);
  };
  const healthApi =
    deps.healthApi ??
    createHealthApi({ getToken, baseUrl: config.healthApiBase });

  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Home page and privacy policy linked from the Google consent screen
  app.get('/', (_req, res) => {
    res.type('html').send(homePage(config));
  });
  app.get('/privacy', (_req, res) => {
    res.type('html').send(privacyPage());
  });

  app.post(['/token', '/revoke'], ...clientSecretBasic);
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicBaseUrl,
      resourceServerUrl: config.mcpUrl,
      scopesSupported: MCP_SCOPES,
      resourceName: 'Google Health MCP',
      // claude.ai keeps its registration forever: don't expire secrets.
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    })
  );

  app.get('/oauth/google/callback', (req, res) =>
    provider.handleGoogleCallback(req, res)
  );

  const bearerAuth = requireBearerAuth({
    verifier: provider,
    expectedResource: config.mcpUrl,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpUrl),
  });

  app.post(
    '/mcp',
    bearerAuth,
    express.json({ limit: '1mb' }),
    async (req, res) => {
      const server = createMcpServer(healthApi);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
          res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
        }
      }
    }
  );

  // Stateless server: no standalone SSE stream and no sessions to delete.
  app.all('/mcp', (_req, res) => {
    res
      .status(405)
      .set('Allow', 'POST')
      .json(jsonRpcError(-32000, 'Method not allowed.'));
  });

  return app;
}
