/**
 * Google OAuth: the upstream identity provider. Users sign in with Google;
 * this server keeps their Google refresh token and hands out short-lived
 * Google access tokens to the tools.
 */

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import {
  type AppConfig,
  GOOGLE_OAUTH_CONFIG,
  HEALTH_API_BASE,
} from '../config.js';
import type { JsonStore } from './store.js';

export interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

export interface GoogleIdTokenClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
}

export interface GoogleIdentity {
  name?: string;
  healthUserId?: string;
  legacyUserId?: string;
}

/** Errors returned by Google; `code` is the OAuth/API error code. */
export class GoogleOAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'GoogleOAuthError';
  }
}

/** The user's Google grant is gone: they must reconnect the connector. */
export class GoogleGrantRevokedError extends Error {
  constructor(message = 'Google authorization expired or was revoked') {
    super(
      `${message}. Reconnect the connector in Claude (Settings → Connectors).`
    );
    this.name = 'GoogleGrantRevokedError';
  }
}

export interface GoogleOAuthClient {
  buildAuthorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<GoogleTokenResponse>;
  refresh(refreshToken: string): Promise<GoogleTokenResponse>;
  verifyIdToken(idToken: string): Promise<GoogleIdTokenClaims>;
  getIdentity(accessToken: string): Promise<GoogleIdentity>;
}

export interface GoogleOAuthClientOptions {
  fetchImpl?: typeof fetch;
  jwks?: JWTVerifyGetKey;
  healthApiBase?: string;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return { error: 'invalid_response', error_description: text };
  }
}

export function createGoogleOAuthClient(
  config: Pick<
    AppConfig,
    | 'googleClientId'
    | 'googleClientSecret'
    | 'googleRedirectUri'
    | 'googleScopes'
  >,
  options: GoogleOAuthClientOptions = {}
): GoogleOAuthClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const healthApiBase = options.healthApiBase ?? HEALTH_API_BASE;
  let jwks = options.jwks;

  async function tokenRequest(
    params: Record<string, string>
  ): Promise<GoogleTokenResponse> {
    const response = await fetchImpl(GOOGLE_OAUTH_CONFIG.TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.googleClientId,
        client_secret: config.googleClientSecret,
        ...params,
      }),
    });
    const body = await readJson(response);
    if (!response.ok) {
      throw new GoogleOAuthError(
        String(body.error ?? 'token_error'),
        String(body.error_description ?? body.error ?? response.statusText),
        response.status
      );
    }
    return body as unknown as GoogleTokenResponse;
  }

  return {
    buildAuthorizeUrl(state: string): string {
      const url = new URL(GOOGLE_OAUTH_CONFIG.AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: config.googleClientId,
        redirect_uri: config.googleRedirectUri,
        response_type: 'code',
        scope: config.googleScopes.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state,
      }).toString();
      return url.href;
    },

    exchangeCode(code: string) {
      return tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.googleRedirectUri,
      });
    },

    refresh(refreshToken: string) {
      return tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
    },

    async verifyIdToken(idToken: string): Promise<GoogleIdTokenClaims> {
      jwks ??= createRemoteJWKSet(new URL(GOOGLE_OAUTH_CONFIG.JWKS_URL));
      const { payload } = await jwtVerify(idToken, jwks, {
        issuer: [...GOOGLE_OAUTH_CONFIG.ISSUERS],
        audience: config.googleClientId,
      });
      if (typeof payload.sub !== 'string') {
        throw new GoogleOAuthError('invalid_id_token', 'id_token has no sub');
      }
      return {
        sub: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        email_verified:
          payload.email_verified === true || payload.email_verified === 'true',
      };
    },

    async getIdentity(accessToken: string): Promise<GoogleIdentity> {
      const response = await fetchImpl(`${healthApiBase}/users/me/identity`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });
      const body = await readJson(response);
      if (!response.ok) {
        const notLinked = JSON.stringify(body).includes('ACCOUNT_NOT_LINKED');
        const error = body.error as { message?: string } | undefined;
        throw new GoogleOAuthError(
          notLinked ? 'account_not_linked' : 'identity_error',
          error?.message ?? `getIdentity failed with ${response.status}`,
          response.status
        );
      }
      return body as GoogleIdentity;
    },
  };
}

const ACCESS_TOKEN_REFRESH_MARGIN_MS = 60_000;

/**
 * Hands out a valid Google access token per user, refreshing when needed.
 * Concurrent callers for the same user share a single refresh.
 */
export class GoogleTokenService {
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly store: JsonStore,
    private readonly google: GoogleOAuthClient,
    private readonly now: () => number = Date.now
  ) {}

  async getAccessToken(
    userId: string,
    options: { forceRefresh?: boolean } = {}
  ): Promise<string> {
    const user = this.store.data.users[userId];
    if (!user) {
      throw new GoogleGrantRevokedError('Unknown user');
    }
    if (user.google.revoked) {
      throw new GoogleGrantRevokedError();
    }
    const { accessToken, accessTokenExpiresAt = 0 } = user.google;
    if (
      !options.forceRefresh &&
      accessToken &&
      accessTokenExpiresAt - ACCESS_TOKEN_REFRESH_MARGIN_MS > this.now()
    ) {
      return accessToken;
    }

    const pending = this.inflight.get(userId);
    if (pending) {
      return pending;
    }
    const refresh = this.refresh(userId).finally(() =>
      this.inflight.delete(userId)
    );
    this.inflight.set(userId, refresh);
    return refresh;
  }

  private async refresh(userId: string): Promise<string> {
    const user = this.store.data.users[userId];
    let tokens: GoogleTokenResponse;
    try {
      tokens = await this.google.refresh(user.google.refreshToken);
    } catch (error) {
      if (error instanceof GoogleOAuthError && error.code === 'invalid_grant') {
        user.google.revoked = true;
        user.updatedAt = this.now();
        await this.store.save();
        throw new GoogleGrantRevokedError();
      }
      throw error;
    }

    const now = this.now();
    user.google = {
      ...user.google,
      accessToken: tokens.access_token,
      accessTokenExpiresAt: now + tokens.expires_in * 1000,
      // Google normally omits refresh_token on refresh: keep the old one.
      refreshToken: tokens.refresh_token ?? user.google.refreshToken,
      refreshTokenExpiresAt: tokens.refresh_token_expires_in
        ? now + tokens.refresh_token_expires_in * 1000
        : user.google.refreshTokenExpiresAt,
      scope: tokens.scope ?? user.google.scope,
    };
    user.updatedAt = now;
    await this.store.save();
    return tokens.access_token;
  }
}
