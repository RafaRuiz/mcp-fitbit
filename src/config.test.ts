import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GOOGLE_SCOPES,
  HEALTH_API_BASE,
  loadConfig,
} from './config.js';

const baseEnv = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  PUBLIC_BASE_URL: 'https://health.example.com/',
  ALLOWED_EMAILS: 'Rafa@Example.com, other@example.com',
};

describe('loadConfig', () => {
  it('builds derived URLs and defaults', () => {
    const config = loadConfig(baseEnv);

    expect(config.publicBaseUrl.href).toBe('https://health.example.com/');
    expect(config.mcpUrl.href).toBe('https://health.example.com/mcp');
    expect(config.googleRedirectUri).toBe(
      'https://health.example.com/oauth/google/callback'
    );
    expect(config.allowedEmails).toEqual([
      'rafa@example.com',
      'other@example.com',
    ]);
    expect(config.googleScopes).toEqual([...DEFAULT_GOOGLE_SCOPES]);
    expect(config.port).toBe(8000);
    expect(config.trustProxy).toBe(1);
    expect(config.dataDir).toBe('./data');
    expect(config.healthApiBase).toBe(HEALTH_API_BASE);
    expect(config.accessTokenTtlSeconds).toBe(3600);
    expect(config.refreshTokenTtlSeconds).toBe(90 * 24 * 3600);
  });

  it('keeps a base path in PUBLIC_BASE_URL', () => {
    const config = loadConfig({
      ...baseEnv,
      PUBLIC_BASE_URL: 'https://example.com/health',
    });
    expect(config.mcpUrl.href).toBe('https://example.com/health/mcp');
  });

  it('reads optional overrides', () => {
    const config = loadConfig({
      ...baseEnv,
      PORT: '9000',
      TRUST_PROXY: '2',
      DATA_DIR: '/data',
      GOOGLE_SCOPES: 'openid email extra',
      HEALTH_API_BASE: 'http://localhost:1234/v4',
      MCP_ACCESS_TOKEN_TTL_SECONDS: '60',
      MCP_REFRESH_TOKEN_TTL_SECONDS: '120',
    });
    expect(config.port).toBe(9000);
    expect(config.trustProxy).toBe(2);
    expect(config.dataDir).toBe('/data');
    expect(config.googleScopes).toEqual(['openid', 'email', 'extra']);
    expect(config.healthApiBase).toBe('http://localhost:1234/v4');
    expect(config.accessTokenTtlSeconds).toBe(60);
    expect(config.refreshTokenTtlSeconds).toBe(120);
  });

  it('reports every missing required variable', () => {
    expect(() => loadConfig({})).toThrow(
      'Missing required environment variables: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, PUBLIC_BASE_URL, ALLOWED_EMAILS'
    );
  });

  it('rejects invalid values', () => {
    expect(() =>
      loadConfig({ ...baseEnv, PUBLIC_BASE_URL: 'not a url' })
    ).toThrow('PUBLIC_BASE_URL must be an absolute URL');
    expect(() => loadConfig({ ...baseEnv, ALLOWED_EMAILS: ' , ' })).toThrow(
      'ALLOWED_EMAILS must contain at least one email'
    );
    expect(() => loadConfig({ ...baseEnv, PORT: 'abc' })).toThrow(
      'PORT must be a non-negative integer'
    );
  });
});
