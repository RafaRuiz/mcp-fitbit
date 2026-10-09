import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config.js';
import type { GoogleOAuthClient } from './oauth/google.js';
import { JsonStore } from './oauth/store.js';
import { createApp } from './server.js';

const REDIRECT_URI = 'http://localhost:5555/callback';

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

describe('HTTP server (integration)', () => {
  let appServer: http.Server;
  let healthServer: http.Server;
  let base: string;
  const healthRequests: { path: string; auth?: string }[] = [];

  const google: GoogleOAuthClient = {
    buildAuthorizeUrl: (state) => `https://google.test/auth?state=${state}`,
    exchangeCode: vi.fn(async () => ({
      access_token: 'google-access',
      expires_in: 3600,
      refresh_token: 'google-refresh',
      id_token: 'id-token',
    })),
    refresh: vi.fn(),
    verifyIdToken: vi.fn(async () => ({
      sub: 'sub-1',
      email: 'rafa@example.com',
      email_verified: true,
    })),
    getIdentity: vi.fn(async () => ({ healthUserId: '42' })),
  };

  beforeAll(async () => {
    // Stub Google Health API
    const healthApp = express();
    healthApp.use((req, res) => {
      healthRequests.push({ path: req.path, auth: req.headers.authorization });
      res.json({ age: 40, membershipStartDate: '2015-01-01' });
    });
    const health = await listen(healthApp);
    healthServer = health.server;

    appServer = http.createServer();
    await new Promise<void>((resolve) =>
      appServer.listen(0, '127.0.0.1', resolve)
    );
    base = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
    const config = loadConfig({
      GOOGLE_CLIENT_ID: 'gid',
      GOOGLE_CLIENT_SECRET: 'gsecret',
      PUBLIC_BASE_URL: base,
      ALLOWED_EMAILS: 'rafa@example.com',
      HEALTH_API_BASE: `${health.url}/v4`,
    });
    appServer.on(
      'request',
      createApp({ config, store: JsonStore.inMemory(), google })
    );
  });

  afterAll(() => {
    appServer.close();
    healthServer.close();
  });

  const form = (body: Record<string, string>) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });

  const mcp = (token: string | undefined, body: unknown) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

  async function registerClient(extra: Record<string, unknown> = {}) {
    const response = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'test',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        ...extra,
      }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as {
      client_id: string;
      client_secret?: string;
    };
  }

  async function authorize(clientId: string) {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'client-state',
      resource: `${base}/mcp`,
    });
    const toGoogle = await fetch(`${base}/authorize?${params}`, {
      redirect: 'manual',
    });
    expect(toGoogle.status).toBe(302);
    const tx = new URL(toGoogle.headers.get('location')!).searchParams.get(
      'state'
    )!;

    const back = await fetch(
      `${base}/oauth/google/callback?state=${tx}&code=google-code`,
      { redirect: 'manual' }
    );
    expect(back.status).toBe(302);
    const location = new URL(back.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get('state')).toBe('client-state');
    return { code: location.searchParams.get('code')!, verifier };
  }

  it('serves health and discovery metadata', async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({
      status: 'ok',
    });

    const unauthenticated = await mcp(undefined, {});
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toContain(
      `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`
    );

    const resource = await (
      await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)
    ).json();
    expect(resource).toMatchObject({
      resource: `${base}/mcp`,
      authorization_servers: [`${base}/`],
      scopes_supported: ['health'],
    });

    const metadata = await (
      await fetch(`${base}/.well-known/oauth-authorization-server`)
    ).json();
    expect(metadata).toMatchObject({
      issuer: `${base}/`,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
    });

    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });

  it('serves the home page and privacy policy for the consent screen', async () => {
    const home = await fetch(`${base}/`);
    expect(home.headers.get('content-type')).toContain('text/html');
    expect(await home.text()).toContain(`${base}/mcp`);

    const privacy = await fetch(`${base}/privacy`);
    expect(privacy.status).toBe(200);
    expect(await privacy.text()).toContain(
      'Google API Services User Data Policy'
    );
  });

  it('rejects registrations with foreign redirect URIs', async () => {
    const response = await fetch(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'invalid_client_metadata',
    });
  });

  it('runs the full OAuth flow and serves tools for the signed-in user', async () => {
    const { client_id } = await registerClient();
    const { code, verifier } = await authorize(client_id);

    const tokenResponse = await fetch(
      `${base}/token`,
      form({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id,
        redirect_uri: REDIRECT_URI,
        resource: `${base}/mcp`,
      })
    );
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token: string;
    };

    const init = await mcp(tokens.access_token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    });
    expect(init.status).toBe(200);
    const initBody = await init.json();
    expect(initBody.result.serverInfo.name).toBe('google-health');

    const list = await mcp(tokens.access_token, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const names = (await list.json()).result.tools.map(
      (tool: { name: string }) => tool.name
    );
    expect(names).toEqual([
      'list_data_points',
      'get_data_point',
      'reconcile_data_points',
      'daily_rollup',
      'rollup',
      'get_profile',
      'get_settings',
      'get_identity',
      'log_food',
      'delete_food_logs',
      'log_water',
      'update_water_log',
      'delete_water_logs',
    ]);

    const call = await mcp(tokens.access_token, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_profile', arguments: {} },
    });
    const callBody = await call.json();
    expect(JSON.parse(callBody.result.content[0].text)).toEqual({
      age: 40,
      membershipStartDate: '2015-01-01',
    });
    expect(healthRequests.at(-1)).toEqual({
      path: '/v4/users/me/profile',
      auth: 'Bearer google-access',
    });

    const refreshed = await fetch(
      `${base}/token`,
      form({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id,
      })
    );
    expect(refreshed.status).toBe(200);
    const newTokens = await refreshed.json();
    expect(newTokens.access_token).not.toBe(tokens.access_token);
  });

  it('accepts client_secret_basic on the token endpoint', async () => {
    const { client_id, client_secret } = await registerClient({
      token_endpoint_auth_method: 'client_secret_basic',
    });
    expect(client_secret).toBeTruthy();
    const { code, verifier } = await authorize(client_id);

    const response = await fetch(`${base}/token`, {
      ...form({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      }),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${client_id}:${client_secret}`).toString('base64')}`,
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('access_token');
  });

  it('rejects a wrong PKCE verifier', async () => {
    const { client_id } = await registerClient();
    const { code } = await authorize(client_id);

    const response = await fetch(
      `${base}/token`,
      form({
        grant_type: 'authorization_code',
        code,
        code_verifier: 'x'.repeat(43),
        client_id,
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_grant' });
  });
});
