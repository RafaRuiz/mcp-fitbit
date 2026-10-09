/**
 * Small JSON-file store for OAuth state that must survive restarts:
 * registered MCP clients, MCP refresh tokens (hashed) and each user's Google
 * tokens. Writes are serialized and atomic (temp file + rename, mode 0600).
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface StoredGoogleTokens {
  refreshToken: string;
  accessToken?: string;
  /** Epoch milliseconds */
  accessTokenExpiresAt?: number;
  /** Epoch milliseconds, when Google reports refresh_token_expires_in */
  refreshTokenExpiresAt?: number;
  scope?: string;
  revoked?: boolean;
}

export interface StoredUser {
  /** Google account subject (stable id) */
  sub: string;
  email: string;
  healthUserId?: string;
  legacyUserId?: string;
  google: StoredGoogleTokens;
  createdAt: number;
  updatedAt: number;
}

export interface StoredRefreshToken {
  userId: string;
  clientId: string;
  scopes: string[];
  resource: string;
  /** Epoch milliseconds */
  expiresAt: number;
  /** Set once the token has been exchanged for a new one */
  rotatedAt?: number;
}

export interface StoreData {
  version: 1;
  clients: Record<string, OAuthClientInformationFull>;
  /** Keyed by sha256 of the refresh token */
  refreshTokens: Record<string, StoredRefreshToken>;
  /** Keyed by Google sub */
  users: Record<string, StoredUser>;
}

function emptyData(): StoreData {
  return { version: 1, clients: {}, refreshTokens: {}, users: {} };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export class JsonStore {
  readonly data: StoreData;
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string | null,
    data: StoreData,
    private readonly now: () => number
  ) {
    this.data = data;
  }

  /** Opens (or creates) a store persisted at `filePath`. */
  static async open(
    filePath: string,
    now: () => number = Date.now
  ): Promise<JsonStore> {
    let data = emptyData();
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      data = { ...emptyData(), ...(JSON.parse(raw) as Partial<StoreData>) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(
          `Could not read OAuth store ${filePath}: ${(error as Error).message}`
        );
      }
    }
    const store = new JsonStore(filePath, data, now);
    store.prune();
    return store;
  }

  /** Non-persistent store, for tests. */
  static inMemory(now: () => number = Date.now): JsonStore {
    return new JsonStore(null, emptyData(), now);
  }

  /** Removes expired refresh tokens. */
  prune(): void {
    const now = this.now();
    for (const [key, token] of Object.entries(this.data.refreshTokens)) {
      if (token.expiresAt <= now) {
        delete this.data.refreshTokens[key];
      }
    }
  }

  /** Persists the current state. Writes are queued so they never interleave. */
  save(): Promise<void> {
    if (!this.filePath) {
      return Promise.resolve();
    }
    const filePath = this.filePath;
    this.writeChain = this.writeChain.then(async () => {
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const tempPath = `${filePath}.${process.pid}.tmp`;
        await fs.writeFile(tempPath, JSON.stringify(this.data, null, 2), {
          mode: 0o600,
        });
        await fs.rename(tempPath, filePath);
      } catch (error) {
        console.error(`Failed to persist OAuth store ${filePath}:`, error);
      }
    });
    return this.writeChain;
  }

  /** Waits for pending writes. */
  flush(): Promise<void> {
    return this.writeChain;
  }
}
