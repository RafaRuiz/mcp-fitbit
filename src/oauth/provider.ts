/**
 * OAuth 2.1 authorization server for MCP clients (claude.ai, Claude Code,
 * MCP Inspector) that delegates user sign-in to Google.
 *
 * Flow: client → /authorize → Google consent → /oauth/google/callback →
 * client redirect with our own authorization code → /token issues MCP
 * tokens bound to the Google user. Tools then use that user's Google tokens.
 */

import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  ALLOWED_REMOTE_REDIRECT_URIS,
  type AppConfig,
  LOOPBACK_HOSTS,
  MCP_SCOPES,
} from '../config.js';
import {
  GoogleGrantRevokedError,
  type GoogleIdentity,
  type GoogleOAuthClient,
  GoogleOAuthError,
  type GoogleTokenService,
} from './google.js';
import { generateToken, hashToken, type JsonStore } from './store.js';

const PENDING_AUTHORIZATION_TTL_MS = 10 * 60_000;
const AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;
/** Lets a client retry a refresh (e.g. two parallel refreshes) briefly. */
const REFRESH_TOKEN_REUSE_GRACE_MS = 60_000;
const MAX_REGISTERED_CLIENTS = 500;

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  resource: string;
  expiresAt: number;
}

interface IssuedCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  userId: string;
  expiresAt: number;
}

interface AccessTokenRecord {
  clientId: string;
  userId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
}

export function isAllowedRedirectUri(uri: string): boolean {
  if (ALLOWED_REMOTE_REDIRECT_URIS.includes(uri)) {
    return true;
  }
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname);
  } catch {
    return false;
  }
}

function normalizeResource(resource: string | URL): string {
  const text = String(resource);
  const hash = text.indexOf('#');
  return (hash === -1 ? text : text.slice(0, hash)).replace(/\/$/, '');
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!
  );
}

function htmlPage(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

export interface HealthOAuthProviderOptions {
  config: Pick<
    AppConfig,
    | 'mcpUrl'
    | 'allowedEmails'
    | 'accessTokenTtlSeconds'
    | 'refreshTokenTtlSeconds'
  >;
  store: JsonStore;
  google: GoogleOAuthClient;
  tokens: GoogleTokenService;
  now?: () => number;
}

export class HealthOAuthProvider implements OAuthServerProvider {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, IssuedCode>();
  /** Keyed by sha256 of the access token; memory only (clients refresh after a restart) */
  private readonly accessTokens = new Map<string, AccessTokenRecord>();
  private readonly config: HealthOAuthProviderOptions['config'];
  private readonly store: JsonStore;
  private readonly google: GoogleOAuthClient;
  private readonly tokens: GoogleTokenService;
  private readonly now: () => number;
  private readonly resource: string;

  constructor(options: HealthOAuthProviderOptions) {
    this.config = options.config;
    this.store = options.store;
    this.google = options.google;
    this.tokens = options.tokens;
    this.now = options.now ?? Date.now;
    this.resource = normalizeResource(options.config.mcpUrl);
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.store.data.clients[clientId],
      registerClient: async (client) => {
        const invalid = client.redirect_uris.filter(
          (uri) => !isAllowedRedirectUri(uri)
        );
        if (invalid.length > 0) {
          throw new InvalidClientMetadataError(
            `redirect_uri not allowed: ${invalid.join(', ')}`
          );
        }
        if (
          Object.keys(this.store.data.clients).length >= MAX_REGISTERED_CLIENTS
        ) {
          throw new InvalidClientMetadataError(
            'Client registration limit reached'
          );
        }
        // The SDK registration handler already generated client_id.
        const full = {
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(this.now() / 1000),
          ...client,
        } as OAuthClientInformationFull;
        this.store.data.clients[full.client_id] = full;
        await this.store.save();
        return full;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    if (
      params.resource &&
      normalizeResource(params.resource) !== this.resource
    ) {
      throw new InvalidTargetError(`Unknown resource ${params.resource.href}`);
    }
    this.pruneExpired();
    const transactionId = generateToken();
    this.pending.set(transactionId, {
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      resource: this.resource,
      expiresAt: this.now() + PENDING_AUTHORIZATION_TTL_MS,
    });
    res.redirect(302, this.google.buildAuthorizeUrl(transactionId));
  }

  /** Handles GET /oauth/google/callback (the redirect back from Google). */
  async handleGoogleCallback(req: Request, res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    const query = req.query as Record<string, unknown>;
    const state = typeof query.state === 'string' ? query.state : undefined;
    const pending = state ? this.pending.get(state) : undefined;
    if (state) {
      this.pending.delete(state);
    }
    if (!pending || pending.expiresAt < this.now()) {
      res
        .status(400)
        .send(
          htmlPage(
            'Authorization expired',
            'This sign-in link is no longer valid. Start the connection again from Claude.'
          )
        );
      return;
    }

    if (typeof query.error === 'string') {
      this.redirectWithError(
        res,
        pending,
        'access_denied',
        `Google: ${query.error}`
      );
      return;
    }
    if (typeof query.code !== 'string') {
      this.redirectWithError(res, pending, 'invalid_request', 'Missing code');
      return;
    }

    try {
      const googleTokens = await this.google.exchangeCode(query.code);
      if (!googleTokens.id_token) {
        throw new GoogleOAuthError(
          'invalid_response',
          'Google sent no id_token'
        );
      }
      const claims = await this.google.verifyIdToken(googleTokens.id_token);
      const email = claims.email?.toLowerCase();
      if (
        !email ||
        !claims.email_verified ||
        !this.config.allowedEmails.includes(email)
      ) {
        console.error(`Rejected sign-in from non-allowed account ${email}`);
        this.redirectWithError(
          res,
          pending,
          'access_denied',
          'This Google account is not allowed to use this server'
        );
        return;
      }
      if (!googleTokens.refresh_token) {
        throw new GoogleOAuthError(
          'invalid_response',
          'Google sent no refresh_token'
        );
      }

      let identity: GoogleIdentity;
      try {
        identity = await this.google.getIdentity(googleTokens.access_token);
      } catch (error) {
        if (
          error instanceof GoogleOAuthError &&
          error.code === 'account_not_linked'
        ) {
          res
            .status(403)
            .send(
              htmlPage(
                'Google Health account not set up',
                'Open the Google Health app on your phone, sign in with this Google account and finish moving your Fitbit data. Then connect again from Claude.'
              )
            );
          return;
        }
        throw error;
      }

      const now = this.now();
      const existing = this.store.data.users[claims.sub];
      this.store.data.users[claims.sub] = {
        sub: claims.sub,
        email,
        healthUserId: identity.healthUserId,
        legacyUserId: identity.legacyUserId,
        google: {
          refreshToken: googleTokens.refresh_token,
          accessToken: googleTokens.access_token,
          accessTokenExpiresAt: now + googleTokens.expires_in * 1000,
          refreshTokenExpiresAt: googleTokens.refresh_token_expires_in
            ? now + googleTokens.refresh_token_expires_in * 1000
            : undefined,
          scope: googleTokens.scope,
        },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await this.store.save();

      const code = generateToken();
      this.codes.set(code, {
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        resource: pending.resource,
        userId: claims.sub,
        expiresAt: now + AUTHORIZATION_CODE_TTL_MS,
      });
      const target = new URL(pending.redirectUri);
      target.searchParams.set('code', code);
      if (pending.state) {
        target.searchParams.set('state', pending.state);
      }
      res.redirect(302, target.href);
    } catch (error) {
      console.error('Google sign-in failed:', error);
      this.redirectWithError(
        res,
        pending,
        'server_error',
        'Google sign-in failed'
      );
    }
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string
  ): Promise<string> {
    const record = this.codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid authorization code');
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const record = this.codes.get(authorizationCode);
    this.codes.delete(authorizationCode);
    if (!record || record.expiresAt < this.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError(
        'Authorization code was issued to another client'
      );
    }
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match');
    }
    if (resource && normalizeResource(resource) !== record.resource) {
      throw new InvalidTargetError('resource does not match');
    }
    return this.issueTokens(client.client_id, record.userId, record.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const key = hashToken(refreshToken);
    const record = this.store.data.refreshTokens[key];
    const now = this.now();
    if (!record || record.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid refresh token');
    }
    if (
      record.expiresAt <= now ||
      (record.rotatedAt !== undefined &&
        now - record.rotatedAt > REFRESH_TOKEN_REUSE_GRACE_MS)
    ) {
      throw new InvalidGrantError('Refresh token expired or already used');
    }
    if (resource && normalizeResource(resource) !== record.resource) {
      throw new InvalidTargetError('resource does not match');
    }

    // Surface a dead Google grant now, so the client asks the user to reconnect.
    try {
      await this.tokens.getAccessToken(record.userId);
    } catch (error) {
      if (error instanceof GoogleGrantRevokedError) {
        throw new InvalidGrantError(error.message);
      }
      console.error('Google token refresh failed during MCP refresh:', error);
    }

    record.rotatedAt ??= now;
    record.expiresAt = Math.min(
      record.expiresAt,
      record.rotatedAt + REFRESH_TOKEN_REUSE_GRACE_MS
    );
    return this.issueTokens(client.client_id, record.userId, record.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.accessTokens.get(hashToken(token));
    if (!record || record.expiresAt <= this.now()) {
      throw new InvalidTokenError('Invalid or expired access token');
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: new URL(record.resource),
      extra: { userId: record.userId },
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ): Promise<void> {
    const key = hashToken(request.token);
    const access = this.accessTokens.get(key);
    if (access?.clientId === client.client_id) {
      this.accessTokens.delete(key);
    }
    const refresh = this.store.data.refreshTokens[key];
    if (refresh?.clientId === client.client_id) {
      delete this.store.data.refreshTokens[key];
      await this.store.save();
    }
  }

  private async issueTokens(
    clientId: string,
    userId: string,
    resource: string
  ): Promise<OAuthTokens> {
    this.pruneExpired();
    const now = this.now();
    const accessToken = generateToken();
    const refreshToken = generateToken();
    this.accessTokens.set(hashToken(accessToken), {
      clientId,
      userId,
      resource,
      scopes: MCP_SCOPES,
      expiresAt: now + this.config.accessTokenTtlSeconds * 1000,
    });
    this.store.data.refreshTokens[hashToken(refreshToken)] = {
      clientId,
      userId,
      resource,
      scopes: MCP_SCOPES,
      expiresAt: now + this.config.refreshTokenTtlSeconds * 1000,
    };
    await this.store.save();
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: MCP_SCOPES.join(' '),
    };
  }

  private redirectWithError(
    res: Response,
    pending: PendingAuthorization,
    error: string,
    description: string
  ): void {
    const target = new URL(pending.redirectUri);
    target.searchParams.set('error', error);
    target.searchParams.set('error_description', description);
    if (pending.state) {
      target.searchParams.set('state', pending.state);
    }
    res.redirect(302, target.href);
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [key, value] of this.pending) {
      if (value.expiresAt < now) this.pending.delete(key);
    }
    for (const [key, value] of this.codes) {
      if (value.expiresAt < now) this.codes.delete(key);
    }
    for (const [key, value] of this.accessTokens) {
      if (value.expiresAt <= now) this.accessTokens.delete(key);
    }
    this.store.prune();
  }
}
