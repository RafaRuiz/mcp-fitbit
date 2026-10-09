import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateToken, hashToken, JsonStore } from './store.js';

describe('JsonStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'health-store-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('persists and reloads data with mode 0600', async () => {
    const file = path.join(dir, 'nested', 'store.json');
    const store = await JsonStore.open(file);
    store.data.users.sub1 = {
      sub: 'sub1',
      email: 'a@example.com',
      google: { refreshToken: 'r' },
      createdAt: 1,
      updatedAt: 1,
    };
    await store.save();

    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
    const reloaded = await JsonStore.open(file);
    expect(reloaded.data.users.sub1.email).toBe('a@example.com');
  });

  it('serializes concurrent writes', async () => {
    const file = path.join(dir, 'store.json');
    const store = await JsonStore.open(file);
    const writes = Array.from({ length: 10 }, (_, i) => {
      store.data.clients[`c${i}`] = {
        client_id: `c${i}`,
        redirect_uris: ['http://localhost/cb'],
      };
      return store.save();
    });
    await Promise.all(writes);
    await store.flush();

    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(Object.keys(saved.clients)).toHaveLength(10);
  });

  it('prunes expired refresh tokens on open', async () => {
    const file = path.join(dir, 'store.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        refreshTokens: {
          old: {
            userId: 'u',
            clientId: 'c',
            scopes: [],
            resource: 'r',
            expiresAt: 100,
          },
          live: {
            userId: 'u',
            clientId: 'c',
            scopes: [],
            resource: 'r',
            expiresAt: 300,
          },
        },
      })
    );

    const store = await JsonStore.open(file, () => 200);

    expect(Object.keys(store.data.refreshTokens)).toEqual(['live']);
    expect(store.data.users).toEqual({});
  });

  it('fails loudly on corrupt files', async () => {
    const file = path.join(dir, 'store.json');
    await fs.writeFile(file, '{not json');
    await expect(JsonStore.open(file)).rejects.toThrow(
      /Could not read OAuth store/
    );
  });

  it('in-memory stores never touch disk', async () => {
    const store = JsonStore.inMemory();
    await expect(store.save()).resolves.toBeUndefined();
  });
});

describe('token helpers', () => {
  it('generates random url-safe tokens and stable hashes', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).toHaveLength(64);
  });
});
