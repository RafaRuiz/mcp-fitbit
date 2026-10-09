import type { Request, Response } from 'express';
import {
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GoogleGrantRevokedError,
  type GoogleOAuthClient,
  GoogleOAuthError,
  type GoogleTokenService,
} from './google.js';
import { HealthOAuthProvider, isAllowedRedirectUri } from './provider.js';
import { hashToken, JsonStore } from './store.js';

const MCP_URL = new URL('https://health.example.com/mcp');
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const client: OAuthClientInformationFull = {
  client_id: 'client-1',
  redirect_uris: [REDIRECT],
};

function fakeRes() {
  const res = {
    statusCode: 200,
    location: undefined as string | undefined,
    body: undefined as string | undefined,
    redirect: vi.fn((status: number, url: string) => {
      res.statusCode = status;
      res.location = url;
    }),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    send: vi.fn((body: string) => {
      res.body = body;
      return res;
    }),
    setHeader: vi.fn(),
  };
  return res;
}

const asRes = (res: ReturnType<typeof fakeRes>) => res as unknown as Response;
const asReq = (query: Record<string, string>) =>
  ({ query }) as unknown as Request;

describe('isAllowedRedirectUri', () => {
  it('allows claude callbacks and loopback redirects only', () => {
    expect(isAllowedRedirectUri(REDIRECT)).toBe(true);
    expect(
      isAllowedRedirectUri('https://claude.com/api/mcp/auth_callback')
    ).toBe(true);
    expect(isAllowedRedirectUri('http://localhost:6274/oauth/callback')).toBe(
      true
    );
    expect(isAllowedRedirectUri('http://127.0.0.1:9999/callback')).toBe(true);
    expect(isAllowedRedirectUri('https://localhost/callback')).toBe(false);
    expect(isAllowedRedirectUri('https://evil.example/callback')).toBe(false);
    expect(isAllowedRedirectUri('not a url')).toBe(false);
  });
});

describe('HealthOAuthProvider', () => {
  let now: number;
  let store: JsonStore;
  let google: {
    buildAuthorizeUrl: ReturnType<typeof vi.fn>;
    exchangeCode: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    verifyIdToken: ReturnType<typeof vi.fn>;
    getIdentity: ReturnType<typeof vi.fn>;
  };
  let tokens: { getAccessToken: ReturnType<typeof vi.fn> };
  let provider: HealthOAuthProvider;

  beforeEach(() => {
    now = 1_000_000;
    store = JsonStore.inMemory(() => now);
    store.data.clients[client.client_id] = client;
    google = {
      buildAuthorizeUrl: vi.fn(
        (state: string) => `https://google.test/auth?state=${state}`
      ),
      exchangeCode: vi.fn().mockResolvedValue({
        access_token: 'g-access',
        expires_in: 3600,
        refresh_token: 'g-refresh',
        id_token: 'id-token',
        scope: 'scopes',
      }),
      refresh: vi.fn(),
      verifyIdToken: vi.fn().mockResolvedValue({
        sub: 'sub-1',
        email: 'Rafa@Example.com',
        email_verified: true,
      }),
      getIdentity: vi.fn().mockResolvedValue({ healthUserId: '42' }),
    };
    tokens = { getAccessToken: vi.fn().mockResolvedValue('g-access') };
    provider = new HealthOAuthProvider({
      config: {
        mcpUrl: MCP_URL,
        allowedEmails: ['rafa@example.com'],
        accessTokenTtlSeconds: 3600,
        refreshTokenTtlSeconds: 7200,
      },
      store,
      google: google as unknown as GoogleOAuthClient,
      tokens: tokens as unknown as GoogleTokenService,
      now: () => now,
    });
  });

  async function startAuthorization(state = 'client-state') {
    const res = fakeRes();
    await provider.authorize(
      client,
      {
        redirectUri: REDIRECT,
        codeChallenge: 'challenge',
        state,
        resource: MCP_URL,
      },
      asRes(res)
    );
    return new URL(res.location!).searchParams.get('state')!;
  }

  async function completeCallback(query: Record<string, string>) {
    const res = fakeRes();
    await provider.handleGoogleCallback(asReq(query), asRes(res));
    return res;
  }

  async function obtainCode() {
    const tx = await startAuthorization();
    const res = await completeCallback({ state: tx, code: 'g-code' });
    return new URL(res.location!).searchParams.get('code')!;
  }

  describe('clientsStore', () => {
    it('registers clients with allowed redirect URIs', async () => {
      const registered = await provider.clientsStore.registerClient!({
        client_id: 'new-client',
        redirect_uris: ['http://localhost:3333/callback'],
      } as OAuthClientInformationFull);

      expect(registered.client_id).toBe('new-client');
      expect(provider.clientsStore.getClient('new-client')).toEqual(registered);
    });

    it('rejects other redirect URIs', async () => {
      await expect(
        provider.clientsStore.registerClient!({
          redirect_uris: ['https://evil.example/cb'],
        })
      ).rejects.toThrow('redirect_uri not allowed: https://evil.example/cb');
    });
  });

  describe('authorize', () => {
    it('redirects to Google with a transaction id', async () => {
      const tx = await startAuthorization();
      expect(tx).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(google.buildAuthorizeUrl).toHaveBeenCalledWith(tx);
    });

    it('rejects foreign resources', async () => {
      await expect(
        provider.authorize(
          client,
          {
            redirectUri: REDIRECT,
            codeChallenge: 'c',
            resource: new URL('https://other.example/mcp'),
          },
          asRes(fakeRes())
        )
      ).rejects.toBeInstanceOf(InvalidTargetError);
    });
  });

  describe('handleGoogleCallback', () => {
    it('stores the user and redirects back with a code', async () => {
      const tx = await startAuthorization('s-1');
      const res = await completeCallback({ state: tx, code: 'g-code' });

      const location = new URL(res.location!);
      expect(location.origin + location.pathname).toBe(REDIRECT);
      expect(location.searchParams.get('state')).toBe('s-1');
      expect(location.searchParams.get('code')).toBeTruthy();
      expect(google.exchangeCode).toHaveBeenCalledWith('g-code');
      expect(store.data.users['sub-1']).toMatchObject({
        email: 'rafa@example.com',
        healthUserId: '42',
        google: {
          refreshToken: 'g-refresh',
          accessToken: 'g-access',
          accessTokenExpiresAt: now + 3600_000,
          scope: 'scopes',
        },
      });
    });

    it('rejects unknown or reused state', async () => {
      const tx = await startAuthorization();
      await completeCallback({ state: tx, code: 'g-code' });
      const reused = await completeCallback({ state: tx, code: 'g-code' });
      const missing = await completeCallback({ code: 'g-code' });

      expect(reused.statusCode).toBe(400);
      expect(reused.body).toContain('Authorization expired');
      expect(missing.statusCode).toBe(400);
    });

    it('rejects expired transactions', async () => {
      const tx = await startAuthorization();
      now += 11 * 60_000;
      const res = await completeCallback({ state: tx, code: 'g-code' });
      expect(res.statusCode).toBe(400);
    });

    it('passes Google errors back to the client', async () => {
      const tx = await startAuthorization();
      const res = await completeCallback({ state: tx, error: 'access_denied' });
      const location = new URL(res.location!);
      expect(location.searchParams.get('error')).toBe('access_denied');
      expect(location.searchParams.get('state')).toBe('client-state');
    });

    it('requires a code', async () => {
      const tx = await startAuthorization();
      const res = await completeCallback({ state: tx });
      expect(new URL(res.location!).searchParams.get('error')).toBe(
        'invalid_request'
      );
    });

    it('denies accounts outside the allowlist', async () => {
      google.verifyIdToken.mockResolvedValue({
        sub: 'sub-2',
        email: 'stranger@example.com',
        email_verified: true,
      });
      const tx = await startAuthorization();
      const res = await completeCallback({ state: tx, code: 'g-code' });

      expect(new URL(res.location!).searchParams.get('error')).toBe(
        'access_denied'
      );
      expect(store.data.users['sub-2']).toBeUndefined();
    });

    it('denies unverified emails', async () => {
      google.verifyIdToken.mockResolvedValue({
        sub: 'sub-1',
        email: 'rafa@example.com',
        email_verified: false,
      });
      const tx = await startAuthorization();
      const res = await completeCallback({ state: tx, code: 'g-code' });
      expect(new URL(res.location!).searchParams.get('error')).toBe(
        'access_denied'
      );
    });

    it('fails when Google sends no refresh token or id token', async () => {
      google.exchangeCode.mockResolvedValueOnce({
        access_token: 'a',
        expires_in: 3600,
        id_token: 'id',
      });
      let tx = await startAuthorization();
      let res = await completeCallback({ state: tx, code: 'g-code' });
      expect(new URL(res.location!).searchParams.get('error')).toBe(
        'server_error'
      );

      google.exchangeCode.mockResolvedValueOnce({
        access_token: 'a',
        expires_in: 3600,
        refresh_token: 'r',
      });
      tx = await startAuthorization();
      res = await completeCallback({ state: tx, code: 'g-code' });
      expect(new URL(res.location!).searchParams.get('error')).toBe(
        'server_error'
      );
    });

    it('explains unlinked Google Health accounts', async () => {
      google.getIdentity.mockRejectedValue(
        new GoogleOAuthError('account_not_linked', 'not linked', 400)
      );
      const tx = await startAuthorization();
      const res = await completeCallback({ state: tx, code: 'g-code' });

      expect(res.statusCode).toBe(403);
      expect(res.body).toContain('Google Health app');
    });
  });

  describe('token exchange', () => {
    it('issues tokens for a valid code exactly once', async () => {
      const code = await obtainCode();
      expect(await provider.challengeForAuthorizationCode(client, code)).toBe(
        'challenge'
      );

      const issued = await provider.exchangeAuthorizationCode(
        client,
        code,
        undefined,
        REDIRECT,
        MCP_URL
      );

      expect(issued).toMatchObject({
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'health',
      });
      const info = await provider.verifyAccessToken(issued.access_token);
      expect(info).toMatchObject({
        clientId: 'client-1',
        scopes: ['health'],
        expiresAt: Math.floor((now + 3600_000) / 1000),
        extra: { userId: 'sub-1' },
      });
      expect(info.resource?.href).toBe(MCP_URL.href);
      await expect(
        provider.exchangeAuthorizationCode(client, code)
      ).rejects.toBeInstanceOf(InvalidGrantError);
    });

    it('rejects codes for other clients, redirects or resources', async () => {
      const other = { ...client, client_id: 'client-2' };
      await expect(
        provider.challengeForAuthorizationCode(other, await obtainCode())
      ).rejects.toBeInstanceOf(InvalidGrantError);
      await expect(
        provider.exchangeAuthorizationCode(other, await obtainCode())
      ).rejects.toThrow('another client');
      await expect(
        provider.exchangeAuthorizationCode(
          client,
          await obtainCode(),
          undefined,
          'http://localhost:1/cb'
        )
      ).rejects.toThrow('redirect_uri');
      await expect(
        provider.exchangeAuthorizationCode(
          client,
          await obtainCode(),
          undefined,
          REDIRECT,
          new URL('https://other.example/mcp')
        )
      ).rejects.toBeInstanceOf(InvalidTargetError);
    });

    it('expires codes', async () => {
      const code = await obtainCode();
      now += 6 * 60_000;
      await expect(
        provider.exchangeAuthorizationCode(client, code)
      ).rejects.toThrow('expired');
    });
  });

  describe('refresh', () => {
    async function issue() {
      return provider.exchangeAuthorizationCode(client, await obtainCode());
    }

    it('rotates refresh tokens with a short reuse grace period', async () => {
      const first = await issue();
      const second = await provider.exchangeRefreshToken(
        client,
        first.refresh_token!
      );
      expect(second.refresh_token).not.toBe(first.refresh_token);
      expect(tokens.getAccessToken).toHaveBeenCalledWith('sub-1');

      // A parallel retry with the old token still works briefly...
      await expect(
        provider.exchangeRefreshToken(client, first.refresh_token!)
      ).resolves.toHaveProperty('access_token');
      // ...but not after the grace period.
      now += 61_000;
      await expect(
        provider.exchangeRefreshToken(client, first.refresh_token!)
      ).rejects.toBeInstanceOf(InvalidGrantError);
      await expect(
        provider.exchangeRefreshToken(client, second.refresh_token!)
      ).resolves.toHaveProperty('access_token');
    });

    it('rejects unknown, foreign or expired refresh tokens', async () => {
      const issued = await issue();
      await expect(
        provider.exchangeRefreshToken(client, 'nope')
      ).rejects.toBeInstanceOf(InvalidGrantError);
      await expect(
        provider.exchangeRefreshToken(
          { ...client, client_id: 'client-2' },
          issued.refresh_token!
        )
      ).rejects.toBeInstanceOf(InvalidGrantError);
      await expect(
        provider.exchangeRefreshToken(
          client,
          issued.refresh_token!,
          undefined,
          new URL('https://other.example/mcp')
        )
      ).rejects.toBeInstanceOf(InvalidTargetError);
      now += 7201_000;
      await expect(
        provider.exchangeRefreshToken(client, issued.refresh_token!)
      ).rejects.toBeInstanceOf(InvalidGrantError);
    });

    it('fails with invalid_grant when the Google grant is revoked', async () => {
      const issued = await issue();
      tokens.getAccessToken.mockRejectedValue(new GoogleGrantRevokedError());

      await expect(
        provider.exchangeRefreshToken(client, issued.refresh_token!)
      ).rejects.toThrow(/Reconnect the connector/);
    });

    it('still refreshes on transient Google errors', async () => {
      const issued = await issue();
      tokens.getAccessToken.mockRejectedValue(new Error('network down'));

      await expect(
        provider.exchangeRefreshToken(client, issued.refresh_token!)
      ).resolves.toHaveProperty('access_token');
    });
  });

  describe('verifyAccessToken / revokeToken', () => {
    it('rejects unknown and expired tokens', async () => {
      await expect(provider.verifyAccessToken('nope')).rejects.toBeInstanceOf(
        InvalidTokenError
      );
      const issued = await provider.exchangeAuthorizationCode(
        client,
        await obtainCode()
      );
      now += 3600_000;
      await expect(
        provider.verifyAccessToken(issued.access_token)
      ).rejects.toBeInstanceOf(InvalidTokenError);
    });

    it('revokes access and refresh tokens of the same client', async () => {
      const issued = await provider.exchangeAuthorizationCode(
        client,
        await obtainCode()
      );

      await provider.revokeToken(
        { ...client, client_id: 'client-2' },
        { token: issued.access_token }
      );
      await expect(
        provider.verifyAccessToken(issued.access_token)
      ).resolves.toBeTruthy();

      await provider.revokeToken(client, { token: issued.access_token });
      await provider.revokeToken(client, { token: issued.refresh_token! });

      await expect(
        provider.verifyAccessToken(issued.access_token)
      ).rejects.toBeInstanceOf(InvalidTokenError);
      expect(
        store.data.refreshTokens[hashToken(issued.refresh_token!)]
      ).toBeUndefined();
    });
  });
});
