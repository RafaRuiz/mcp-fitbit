/**
 * Centralized configuration for the Google Health MCP server.
 * Contains API URLs, OAuth scopes, and the runtime configuration loader.
 */

// === API Configuration ===

export const HEALTH_API_BASE = 'https://health.googleapis.com/v4';

export const GOOGLE_OAUTH_CONFIG = {
  AUTHORIZE_URL: 'https://accounts.google.com/o/oauth2/v2/auth',
  TOKEN_URL: 'https://oauth2.googleapis.com/token',
  JWKS_URL: 'https://www.googleapis.com/oauth2/v3/certs',
  ISSUERS: ['https://accounts.google.com', 'accounts.google.com'],
} as const;

const GOOGLE_HEALTH_SCOPE_PREFIX =
  'https://www.googleapis.com/auth/googlehealth';

/**
 * Google scopes requested when a user connects. `openid email` identify the
 * Google account (checked against ALLOWED_EMAILS); the googlehealth scopes
 * cover every data type exposed by the tools. Override with GOOGLE_SCOPES.
 */
export const DEFAULT_GOOGLE_SCOPES = [
  'openid',
  'email',
  `${GOOGLE_HEALTH_SCOPE_PREFIX}.activity_and_fitness.readonly`,
  `${GOOGLE_HEALTH_SCOPE_PREFIX}.health_metrics_and_measurements.readonly`,
  `${GOOGLE_HEALTH_SCOPE_PREFIX}.sleep.readonly`,
  `${GOOGLE_HEALTH_SCOPE_PREFIX}.nutrition.readonly`,
  `${GOOGLE_HEALTH_SCOPE_PREFIX}.nutrition.writeonly`,
  `${GOOGLE_HEALTH_SCOPE_PREFIX}.profile.readonly`,
  `${GOOGLE_HEALTH_SCOPE_PREFIX}.settings.readonly`,
] as const;

/** Scope this server issues on its own (MCP) access tokens. */
export const MCP_SCOPES = ['health'];

/**
 * Redirect URIs a client may register through dynamic client registration.
 * claude.ai (web, desktop and mobile) uses the claude.ai callback; loopback
 * redirects (any port) are allowed for Claude Code and the MCP Inspector.
 */
export const ALLOWED_REMOTE_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];
export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// === HTTP Configuration ===

export const HTTP_CONFIG = {
  USER_AGENT: 'mcp-google-health/2.0',
  TIMEOUT_MS: 30000,
  MAX_RETRIES: 3,
} as const;

// === Runtime Configuration ===

export interface AppConfig {
  googleClientId: string;
  googleClientSecret: string;
  googleScopes: string[];
  /** Public HTTPS origin of this server, e.g. https://health.example.com */
  publicBaseUrl: URL;
  /** Canonical MCP endpoint (resource identifier): `${publicBaseUrl}/mcp` */
  mcpUrl: URL;
  /** Google redirect URI: `${publicBaseUrl}/oauth/google/callback` */
  googleRedirectUri: string;
  /** Lower-cased Google account emails allowed to connect */
  allowedEmails: string[];
  dataDir: string;
  port: number;
  /** Value for express `trust proxy` (number of proxy hops) */
  trustProxy: number;
  healthApiBase: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
}

const REQUIRED_ENV_VARS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'PUBLIC_BASE_URL',
  'ALLOWED_EMAILS',
] as const;

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string
): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

/**
 * Builds the runtime configuration from environment variables.
 * Throws a descriptive error when required variables are missing or invalid.
 */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const missing = REQUIRED_ENV_VARS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`
    );
  }

  let publicBaseUrl: URL;
  try {
    publicBaseUrl = new URL(env.PUBLIC_BASE_URL!.trim().replace(/\/+$/, ''));
  } catch {
    throw new Error('PUBLIC_BASE_URL must be an absolute URL');
  }
  const base = publicBaseUrl.href.replace(/\/+$/, '');

  const allowedEmails = env
    .ALLOWED_EMAILS!.split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (allowedEmails.length === 0) {
    throw new Error('ALLOWED_EMAILS must contain at least one email');
  }

  const googleScopes = env.GOOGLE_SCOPES?.trim()
    ? env.GOOGLE_SCOPES.trim().split(/\s+/)
    : [...DEFAULT_GOOGLE_SCOPES];

  return {
    googleClientId: env.GOOGLE_CLIENT_ID!.trim(),
    googleClientSecret: env.GOOGLE_CLIENT_SECRET!.trim(),
    googleScopes,
    publicBaseUrl,
    mcpUrl: new URL(`${base}/mcp`),
    googleRedirectUri: `${base}/oauth/google/callback`,
    allowedEmails,
    dataDir: env.DATA_DIR?.trim() || './data',
    port: parseInteger(env.PORT, 8000, 'PORT'),
    trustProxy: parseInteger(env.TRUST_PROXY, 1, 'TRUST_PROXY'),
    healthApiBase: env.HEALTH_API_BASE?.trim() || HEALTH_API_BASE,
    accessTokenTtlSeconds: parseInteger(
      env.MCP_ACCESS_TOKEN_TTL_SECONDS,
      3600,
      'MCP_ACCESS_TOKEN_TTL_SECONDS'
    ),
    refreshTokenTtlSeconds: parseInteger(
      env.MCP_REFRESH_TOKEN_TTL_SECONDS,
      90 * 24 * 3600,
      'MCP_REFRESH_TOKEN_TTL_SECONDS'
    ),
  };
}
