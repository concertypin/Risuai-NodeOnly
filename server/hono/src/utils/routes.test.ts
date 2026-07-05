/**
 * Tests for PocketRisu Hono server.
 *
 * Uses the in-memory fallback of db.ts (no DATABASE_URL needed).
 * Tests cover all major API endpoints.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Hono } from 'hono';
import { registerRoutes } from './routes.js';
import {
  ensureTables, kvSet, kvGet, kvDel, kvList, clearEntities,
  addLogEntry, queryLogs, deleteLogs,
} from './db.js';

// ─── Test App Setup ──────────────────────────────────────────────────────────

let app: Hono;

function testClient(app: Hono) {
  return {
    async get(path: string, headers?: Record<string, string>) {
      const req = new Request(`http://localhost${path}`, {
        method: 'GET',
        headers: { ...headers },
      });
      return app.fetch(req);
    },
    async post(path: string, body?: unknown, headers?: Record<string, string>) {
      const req = new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      return app.fetch(req);
    },
    async put(path: string, body?: unknown, headers?: Record<string, string>) {
      const req = new Request(`http://localhost${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      return app.fetch(req);
    },
    async delete_(path: string, headers?: Record<string, string>) {
      const req = new Request(`http://localhost${path}`, {
        method: 'DELETE',
        headers: { ...headers },
      });
      return app.fetch(req);
    },
    async rawPost(path: string, body?: Buffer | ArrayBuffer, headers?: Record<string, string>) {
      const req = new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { ...headers },
        body: body instanceof Buffer ? new Uint8Array(body) : (body as BodyInit | null | undefined),
      });
      return app.fetch(req);
    },
  };
}

// ─── Test Auth Setup ────────────────────────────────────────────────────────

// Auto-login is used when PASSWORD_HASH is not set.
// We need a session cookie. The /api/login endpoint creates one automatically
// when there's no password set.
let sessionCookie = '';

beforeAll(async () => {
  process.env.PASSWORD_HASH = 'test-password-hash';
  app = new Hono();
  registerRoutes(app);

  // Ensure DB tables (uses in-memory fallback since no DATABASE_URL)
  await ensureTables();

  // Login to get session
  const client = testClient(app);
  const loginRes = await client.post('/api/login', { password: 'test-password-hash' });
  expect(loginRes.status).toBe(200);

  // Extract session cookie
  const setCookieHeader = loginRes.headers.get('set-cookie');
  if (setCookieHeader) {
    const match = setCookieHeader.match(/risuai_session=([^;]+)/);
    if (match) sessionCookie = match[1];
  }
});

beforeEach(async () => {
  await clearEntities();
  // Re-login if needed
  if (!sessionCookie) {
    const client = testClient(app);
    const loginRes = await client.post('/api/login', { password: 'test-password-hash' });
    const setCookieHeader = loginRes.headers.get('set-cookie');
    if (setCookieHeader) {
      const match = setCookieHeader.match(/risuai_session=([^;]+)/);
      if (match) sessionCookie = match[1];
    }
  }
});

afterAll(async () => {
  delete process.env.PASSWORD_HASH;
});

function authHeaders(): Record<string, string> {
  return { Cookie: `risuai_session=${sessionCookie}` };
}

// ─── KV Store Tests ─────────────────────────────────────────────────────────

describe('KV Store', () => {
  it('should set and get values', async () => {
    await kvSet('test/key1', Buffer.from('hello'));
    const val = await kvGet('test/key1');
    expect(val).toBeTruthy();
    expect(val!.toString()).toBe('hello');
  });

  it('should return null for missing keys', async () => {
    const val = await kvGet('nonexistent');
    expect(val).toBeNull();
  });

  it('should delete keys', async () => {
    await kvSet('test/key2', Buffer.from('world'));
    await kvDel('test/key2');
    const val = await kvGet('test/key2');
    expect(val).toBeNull();
  });

  it('should list keys by prefix', async () => {
    await kvSet('list/a', Buffer.from('1'));
    await kvSet('list/b', Buffer.from('2'));
    await kvSet('other/c', Buffer.from('3'));
    const keys = await kvList('list/');
    expect(keys).toHaveLength(2);
    expect(keys).toContain('list/a');
    expect(keys).toContain('list/b');
  });

  it('should return key size', async () => {
    const { kvSize } = await import('./db.js');
    await kvSet('test/size', Buffer.from('12345'));
    const size = await kvSize('test/size');
    expect(size).toBe(5);
  });

  it('should copy values between keys', async () => {
    const { kvCopyValue } = await import('./db.js');
    await kvSet('src/key', Buffer.from('copy-me'));
    await kvCopyValue('src/key', 'dst/key');
    const val = await kvGet('dst/key');
    expect(val!.toString()).toBe('copy-me');
  });
});

// ─── Auth Tests ─────────────────────────────────────────────────────────────

describe('Auth', () => {
  it('should allow login without password when unset', async () => {
    // Temporarily unset password
    const origHash = process.env.PASSWORD_HASH;
    delete process.env.PASSWORD_HASH;

    // Create fresh app to test
    const testApp = new Hono();
    registerRoutes(testApp);
    const client = testClient(testApp);

    const res = await client.post('/api/login', {});
    expect(res.status).toBe(200);

    process.env.PASSWORD_HASH = origHash;
  });

  it('should reject login with wrong password', async () => {
    const client = testClient(app);
    const res = await client.post('/api/login', { password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('should test auth status', async () => {
    const client = testClient(app);
    const res = await client.get('/api/test_auth', authHeaders());
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });

  it('should reject unauthenticated requests', async () => {
    const client = testClient(app);
    const res = await client.get('/api/test_auth');
    const body = await res.json() as { success?: boolean; error?: string };
    expect(body.error).toBeDefined();
  });
});

// ─── Write / Read Tests ──────────────────────────────────────────────────────

describe('Write / Read', () => {
  it('should write and read a non-DB key', async () => {
    const client = testClient(app);
    const keyHex = Buffer.from('settings/theme').toString('hex');

    const writeRes = await client.rawPost(
      '/api/write',
      Buffer.from('dark'),
      { ...authHeaders(), 'file-path': keyHex }
    );
    expect(writeRes.status).toBe(200);

    const readRes = await client.get('/api/read', {
      ...authHeaders(),
      'file-path': keyHex,
    });
    expect(readRes.status).toBe(200);
    const text = await readRes.text();
    expect(text).toBe('dark');
  });

  it('should write database.bin', async () => {
    const client = testClient(app);
    const keyHex = Buffer.from('database/database.bin').toString('hex');
    const testDb = JSON.stringify({ characters: [], version: 1 });

    const res = await client.rawPost(
      '/api/write',
      Buffer.from(testDb),
      { ...authHeaders(), 'file-path': keyHex, 'Content-Type': 'application/octet-stream' }
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; etag?: string };
    expect(body.success).toBe(true);
    expect(body.etag).toBeDefined();
  });

  it('should read database.bin', async () => {
    const client = testClient(app);
    const keyHex = Buffer.from('database/database.bin').toString('hex');

    // First write
    const testDb = JSON.stringify({ characters: [], version: 1 });
    await client.rawPost('/api/write', Buffer.from(testDb), {
      ...authHeaders(), 'file-path': keyHex, 'Content-Type': 'application/octet-stream',
    });

    // Then read
    const res = await client.get('/api/read', { ...authHeaders(), 'file-path': keyHex });
    expect(res.status).toBe(200);
  });

  it('should remove a key', async () => {
    const client = testClient(app);
    const keyHex = Buffer.from('temp/key').toString('hex');

    // Write
    await client.rawPost('/api/write', Buffer.from('temp'), {
      ...authHeaders(), 'file-path': keyHex,
    });

    // Remove
    const res = await client.get('/api/remove', { ...authHeaders(), 'file-path': keyHex });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);

    // Verify gone
    const readRes = await client.get('/api/read', { ...authHeaders(), 'file-path': keyHex });
    expect(readRes.status).toBe(404);
  });
});

// ─── List Tests ─────────────────────────────────────────────────────────────

describe('List', () => {
  it('should list keys by prefix', async () => {
    const client = testClient(app);
    await kvSet('test/alpha', Buffer.from('a'));
    await kvSet('test/beta', Buffer.from('b'));
    await kvSet('other/gamma', Buffer.from('c'));

    const prefixHex = Buffer.from('test/').toString('hex');
    const res = await client.get('/api/list', {
      ...authHeaders(),
      'key-prefix': prefixHex,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; content: string[] };
    expect(body.success).toBe(true);
    expect(body.content).toHaveLength(2);
  });
});

// ─── Logs Tests ─────────────────────────────────────────────────────────────

describe('Logs', () => {
  it('should add and query logs', async () => {
    await addLogEntry({
      timestamp: Date.now(),
      level: 'info',
      origin: 'test',
      message: 'test log entry',
    });

    const entries = await queryLogs({ level: 'info' });
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].message).toBe('test log entry');
  });

  it('should delete logs', async () => {
    await addLogEntry({
      timestamp: Date.now(),
      level: 'warn',
      origin: 'test',
      message: 'to be deleted',
    });
    await deleteLogs();
    const entries = await queryLogs({});
    expect(entries.length).toBe(0);
  });

  it('should submit logs via API', async () => {
    const client = testClient(app);
    const res = await client.post('/api/logs', {
      timestamp: Date.now(),
      level: 'info',
      origin: 'api-test',
      message: 'api test log',
    }, authHeaders());
    expect(res.status).toBe(200);
  });
});

// ─── Stats Tests ────────────────────────────────────────────────────────────

describe('DB Stats', () => {
  it('should return stats', async () => {
    const client = testClient(app);
    await kvSet('test/key', Buffer.from('value'));

    const res = await client.get('/api/db/stats', authHeaders());
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; stats: { totalKeys: number } };
    expect(body.success).toBe(true);
    // At least key we just set
    expect(body.stats).toBeDefined();
  });

  it('should return public stats without auth', async () => {
    const client = testClient(app);
    const res = await client.get('/api/public-stats');
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean };
    expect(body.success).toBe(true);
  });
});

// ─── Backup Tests ───────────────────────────────────────────────────────────

describe('Backup', () => {
  it('should create and list server backups', async () => {
    const client = testClient(app);
    const keyHex = Buffer.from('database/database.bin').toString('hex');

    // Write DB first
    await client.rawPost('/api/write', Buffer.from(JSON.stringify({ characters: [] })), {
      ...authHeaders(), 'file-path': keyHex,
    });

    // Create backup
    const saveRes = await client.post('/api/backup/server/save', {}, authHeaders());
    expect(saveRes.status).toBe(200);

    // List backups
    const listRes = await client.get('/api/backup/server/list', authHeaders());
    expect(listRes.status).toBe(200);
    const body = await listRes.json() as { success: boolean; backups: unknown[] };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.backups)).toBe(true);
  });

  it('should return boot reminder', async () => {
    const client = testClient(app);
    const res = await client.get('/api/backup/boot-reminder');
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; enabled: boolean };
    expect(body.success).toBe(true);
    expect(typeof body.enabled).toBe('boolean');
  });
});

// ─── Chat Store Tests ────────────────────────────────────────────────────────

describe('Chat Store', () => {
  it('should init chat store from DB object', async () => {
    const { initChatStore, stripChatsFromDb, reassembleFullDb, setFullChatStore } = await import('./chat-store.js');

    const testDb = {
      characters: [{
        chaId: 'char1',
        chats: [
          { id: 'chat1', name: 'Test Chat', message: ['hello'], _stub: false },
        ],
      }],
    };

    const store = initChatStore(testDb);
    expect(store.size).toBe(1);
    expect(store.get('char1')?.size).toBe(1);

    // Strip
    const stripped = stripChatsFromDb(testDb) as any;
    expect(stripped.characters[0].chats[0]._stub).toBe(true);
    expect(stripped.characters[0].chats[0].message).toBeUndefined();

    // Reassemble
    const full = reassembleFullDb(stripped) as any;
    const restoredChat = full.characters[0].chats[0];
    // _stub is cleaned up during initChatStore — if the full chat had _stub: false,
    // it stays as false in the store. Reassembly keeps the full chat data.
    // Verify that messages are preserved.
    expect((restoredChat as any)?.message).toEqual(['hello']);
  });

  it('should detect stub flag loss', async () => {
    const { initChatStore, findStubFlagLossChats, setFullChatStore } = await import('./chat-store.js');
    type SomeChat = { id?: string; _stub?: boolean; message?: unknown[] };

    // Setup store with a chat that has messages
    const store = new Map();
    const charChats = new Map<string, SomeChat>();
    charChats.set('chat1', { id: 'chat1', message: ['real messages'] });
    store.set('char1', charChats);
    setFullChatStore(store);

    // Check an incoming DB where a chat has _stub: true but no message array,
    // while the store has full messages for that chat ID.
    // This IS a loss situation (the stub would replace the full chat).
    const incomingDb = {
      characters: [{
        chaId: 'char1',
        chats: [{ id: 'chat1', _stub: true }], // no message array
      }],
    };

    const losses = findStubFlagLossChats(incomingDb);
    expect(losses).toHaveLength(1); // char1/chat1 loses _stub flag without messages
    expect(losses[0].chaId).toBe('char1');

    // Now clear the store — no loss if there's nothing to lose
    setFullChatStore(new Map());
    const noLoss = findStubFlagLossChats(incomingDb);
    expect(noLoss).toHaveLength(0);
    expect(noLoss).toHaveLength(0);
  });
});

// ─── Health Tests ────────────────────────────────────────────────────────────

describe('Health', () => {
  it('should return server info', async () => {
    const client = testClient(app);
    const res = await client.get('/');
    expect(res.status).toBe(200);
  });

  it('should return update check', async () => {
    const client = testClient(app);
    const res = await client.get('/api/update-check');
    expect(res.status).toBe(200);
  });
});

// ─── ETag & Cache Tests ──────────────────────────────────────────────────────

describe('ETag / Cache', () => {
  it('should return ETag on DB write', async () => {
    const client = testClient(app);
    const keyHex = Buffer.from('database/database.bin').toString('hex');
    const testDb = JSON.stringify({ characters: [] });

    const res = await client.rawPost('/api/write', Buffer.from(testDb), {
      ...authHeaders(), 'file-path': keyHex,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { etag?: string };
    expect(body.etag).toBeDefined();
    expect(typeof body.etag).toBe('string');
    expect(body.etag!.length).toBe(16); // SHA256 hex slice
  });
});

// ─── Set Password Tests ──────────────────────────────────────────────────────

describe('Set Password', () => {
  it('should set password when authenticated', async () => {
    const client = testClient(app);
    const res = await client.post('/api/set_password', { password: 'new-hash' }, authHeaders());
    expect(res.status).toBe(200);
  });

  it('should reject when not authenticated', async () => {
    const client = testClient(app);
    const res = await client.post('/api/set_password', { password: 'test' });
    expect(res.status).toBe(401);
  });
});

// ─── Crypto Tests ────────────────────────────────────────────────────────────

describe('Crypto', () => {
  it('should compute SHA256', async () => {
    const client = testClient(app);
    const res = await client.post('/api/crypto', { action: 'sha256', data: 'hello' }, authHeaders());
    expect(res.status).toBe(200);
    const body = await res.json() as { hash: string };
    expect(body.hash).toBeDefined();
    expect(body.hash.length).toBe(64); // hex SHA256
  });

  it('should reject without auth', async () => {
    const client = testClient(app);
    const res = await client.post('/api/crypto', { action: 'sha256', data: 'test' });
    expect(res.status).toBe(401);
  });
});

// ─── Session Tests ──────────────────────────────────────────────────────────

describe('Session', () => {
  it('should refresh session', async () => {
    const client = testClient(app);
    const res = await client.post('/api/token/refresh', {}, authHeaders());
    expect(res.status).toBe(200);
  });

  it('should return password status', async () => {
    const client = testClient(app);
    const res = await client.get('/api/password');
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('set');
  });
});
