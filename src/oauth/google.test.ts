import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGoogleOAuthClient,
  GoogleGrantRevokedError,
  type GoogleOAuthClient,
  GoogleOAuthError,
  GoogleTokenService,
} from './google.js';
import { JsonStore } from './store.js';

const config = {
  googleClientId: 'gid',
  googleClientSecret: 'gsecret',
  googleRedirectUri: 'https://health.example.com/oauth/google/callback',
  googleScopes: ['openid', 'email', 'scope-a'],
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

describe('createGoogleOAuthClient', () => {
  const fetchImpl = vi.fn<typeof fetch>();

  beforeEach(() => fetchImpl.mockReset());

  it('builds an offline consent URL', () => {
    const client = createGoogleOAuthClient(config, { fetchImpl });
    const url = new URL(client.buildAuthorizeUrl('tx-1'));

    expect(url.origin + url.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth'
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'gid',
      redirect_uri: config.googleRedirectUri,
      response_type: 'code',
      scope: 'openid email scope-a',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: 'tx-1',
    });
  });

  it('exchanges codes and refreshes tokens with client credentials', async () => {
    fetchImpl.mockImplementation(async () =>
      json(200, { access_token: 'a', expires_in: 3600 })
    );
    const client = createGoogleOAuthClient(config, { fetchImpl });

    await client.exchangeCode('code-1');
    await client.refresh('refresh-1');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    const body = new URLSearchParams(String(init!.body));
    expect(Object.fromEntries(body)).toEqual({
      client_id: 'gid',
      client_secret: 'gsecret',
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: config.googleRedirectUri,
    });
    const refreshBody = new URLSearchParams(
      String(fetchImpl.mock.calls[1][1]!.body)
    );
    expect(refreshBody.get('grant_type')).toBe('refresh_token');
    expect(refreshBody.get('refresh_token')).toBe('refresh-1');
  });

  it('turns token errors into GoogleOAuthError', async () => {
    fetchImpl.mockResolvedValue(
      json(400, { error: 'invalid_grant', error_description: 'Token expired' })
    );
    const client = createGoogleOAuthClient(config, { fetchImpl });

    await expect(client.refresh('r')).rejects.toMatchObject({
      code: 'invalid_grant',
      message: 'Token expired',
      status: 400,
    });
  });

  it('verifies id tokens against the JWKS, issuer and audience', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    const jwks = createLocalJWKSet({ keys: [jwk] });
    const sign = (claims: Record<string, unknown>, audience = 'gid') =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer('https://accounts.google.com')
        .setAudience(audience)
        .setSubject('sub-1')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
    const client = createGoogleOAuthClient(config, { fetchImpl, jwks });

    await expect(
      client.verifyIdToken(
        await sign({ email: 'a@example.com', email_verified: true })
      )
    ).resolves.toEqual({
      sub: 'sub-1',
      email: 'a@example.com',
      email_verified: true,
    });
    await expect(
      client.verifyIdToken(await sign({ email: 'a@example.com' }, 'other'))
    ).rejects.toThrow();
  });

  it('reads the identity and detects unlinked accounts', async () => {
    const client = createGoogleOAuthClient(config, {
      fetchImpl,
      healthApiBase: 'https://health.test/v4',
    });
    fetchImpl.mockResolvedValueOnce(
      json(200, { healthUserId: '123', legacyUserId: 'ABC' })
    );
    await expect(client.getIdentity('at')).resolves.toEqual({
      healthUserId: '123',
      legacyUserId: 'ABC',
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://health.test/v4/users/me/identity'
    );

    fetchImpl.mockResolvedValueOnce(
      json(400, {
        error: {
          message: 'Not linked',
          details: [{ reason: 'ACCOUNT_NOT_LINKED' }],
        },
      })
    );
    await expect(client.getIdentity('at')).rejects.toMatchObject({
      code: 'account_not_linked',
      message: 'Not linked',
    });
  });
});

describe('GoogleTokenService', () => {
  let now: number;
  let store: JsonStore;
  let google: { refresh: ReturnType<typeof vi.fn> };
  let service: GoogleTokenService;

  beforeEach(() => {
    now = 1_000_000;
    store = JsonStore.inMemory(() => now);
    store.data.users.u1 = {
      sub: 'u1',
      email: 'a@example.com',
      google: {
        refreshToken: 'refresh-1',
        accessToken: 'access-1',
        accessTokenExpiresAt: now + 10 * 60_000,
      },
      createdAt: now,
      updatedAt: now,
    };
    google = { refresh: vi.fn() };
    service = new GoogleTokenService(
      store,
      google as unknown as GoogleOAuthClient,
      () => now
    );
  });

  it('returns the cached access token while valid', async () => {
    await expect(service.getAccessToken('u1')).resolves.toBe('access-1');
    expect(google.refresh).not.toHaveBeenCalled();
  });

  it('refreshes once for concurrent callers and keeps the refresh token', async () => {
    now += 10 * 60_000;
    google.refresh.mockResolvedValue({
      access_token: 'access-2',
      expires_in: 3600,
      scope: 'scope-a',
    });

    const tokens = await Promise.all([
      service.getAccessToken('u1'),
      service.getAccessToken('u1'),
      service.getAccessToken('u1'),
    ]);

    expect(tokens).toEqual(['access-2', 'access-2', 'access-2']);
    expect(google.refresh).toHaveBeenCalledTimes(1);
    expect(google.refresh).toHaveBeenCalledWith('refresh-1');
    expect(store.data.users.u1.google).toMatchObject({
      refreshToken: 'refresh-1',
      accessToken: 'access-2',
      accessTokenExpiresAt: now + 3600_000,
      scope: 'scope-a',
    });
  });

  it('stores rotated refresh tokens and forces refreshes on demand', async () => {
    google.refresh.mockResolvedValue({
      access_token: 'access-2',
      expires_in: 3600,
      refresh_token: 'refresh-2',
      refresh_token_expires_in: 604800,
    });

    await service.getAccessToken('u1', { forceRefresh: true });

    expect(store.data.users.u1.google.refreshToken).toBe('refresh-2');
    expect(store.data.users.u1.google.refreshTokenExpiresAt).toBe(
      now + 604800_000
    );
  });

  it('marks the user revoked on invalid_grant', async () => {
    google.refresh.mockRejectedValue(
      new GoogleOAuthError(
        'invalid_grant',
        'Token has been expired or revoked.'
      )
    );

    await expect(
      service.getAccessToken('u1', { forceRefresh: true })
    ).rejects.toBeInstanceOf(GoogleGrantRevokedError);
    expect(store.data.users.u1.google.revoked).toBe(true);
    await expect(service.getAccessToken('u1')).rejects.toThrow(
      /Reconnect the connector/
    );
  });

  it('propagates transient errors without revoking', async () => {
    google.refresh.mockRejectedValue(new Error('network down'));

    await expect(
      service.getAccessToken('u1', { forceRefresh: true })
    ).rejects.toThrow('network down');
    expect(store.data.users.u1.google.revoked).toBeUndefined();
  });

  it('rejects unknown users', async () => {
    await expect(service.getAccessToken('nobody')).rejects.toBeInstanceOf(
      GoogleGrantRevokedError
    );
  });
});
