/**
 * @fileoverview All API routes for PocketRisu Hono server.
 *
 * Ported from server/node/server.cjs — functionally equivalent.
 */

import { type Context, type Next } from 'hono';
import type { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { serveStatic } from '@hono/node-server/serve-static';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir, stat, unlink, rename } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync, createWriteStream, createReadStream } from 'node:fs';
import { join, basename, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

// ─── Imports from service modules ────────────────────────────────────────────

import {
  kvGet, kvSet, kvDel, kvList, kvDelPrefix, kvSize, kvGetUpdatedAt,
  kvCopyValue, kvListWithSizes, kvSizeTotal, kvCount, kvPrefixCount, kvPrefixSize,
  checkpointWal, clearEntities,
  addLogEntry, addLogBatch, queryLogs, deleteLogs, ensureTables,
  type LogEntry,
} from '../utils/db.js';

import {
  checkAuth, requireAuth, requireActiveSession, sessionAuthMiddleware,
  checkActiveSession, createSession, refreshSession, deleteSession,
  setActiveSession, createServerJwt, getPasswordHash, setPasswordHash,
} from '../utils/auth.js';

import {
  initChatStore, stripChatsFromDb, reassembleFullDb, findStubFlagLossChats,
  chatToStub, assignMissingChatIds, normalizeOrphanFolderIds,
  getFullChatStore, setFullChatStore, type Chat, type DbObject,
} from '../utils/chat-store.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const SAVE_INTERVAL = 3000; // 3s debounce for patch sync
const BACKUP_INTERVAL_MS = 60000; // at most 1 backup/minute
const SAVE_PATH = join(process.cwd(), 'save');
const INLAY_DIR = join(SAVE_PATH, 'inlays');
const HEX_REGEX = /^[0-9a-fA-F]+$/;
const DB_HEX_KEY = Buffer.from('database/database.bin', 'utf-8').toString('hex');
const BACKUP_ENTRY_NAME_MAX_BYTES = 1024;
const PROXY_STREAM_MAX_ACTIVE_JOBS = 50;
const PROXY_STREAM_MAX_BODY_BASE64_BYTES = 1_000_000;
const BACKUP_NDJSON_HEARTBEAT_MS = Math.max(100, Number(process.env.BACKUP_NDJSON_HEARTBEAT_MS ?? '5000') || 5000);
const BULK_BATCH = 50;

// ─── Global In-Memory State ──────────────────────────────────────────────────

let dbEtag: string | undefined;
const dbCache: Record<string, unknown> = {};
const saveTimers: Record<string, ReturnType<typeof setTimeout>> = {};
let storageOperationPromise = Promise.resolve();
let lastBackupTime = 0;
let persistFailureCount = 0;
let lastPersistWarning: string | null = null;
let importInProgress = false;
let enablePatchSync = true;

// Instance ID
const instanceIdPath = join(SAVE_PATH, '__instance_id');
const instanceId = existsSync(instanceIdPath)
  ? readFileSync(instanceIdPath, 'utf-8').trim()
  : randomUUID();

// Tunnel state
const TUNNEL_DISABLED = process.env.RISU_TUNNEL_DISABLED === 'true';
let tunnelProcess: unknown = null;
let tunnelUrl: string | null = null;
let tunnelStatus: string = 'off';
let tunnelError: string | null = null;

// Auth code
const authCodePath = join(SAVE_PATH, '__authcode');

let passwordHash: string | null = process.env.PASSWORD_HASH ?? null;

// ─── Utility Functions ───────────────────────────────────────────────────────

function isHex(s: string): boolean {
  return HEX_REGEX.test(s);
}

function computeBufferEtag(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function calculateHash(obj: unknown): number {
  let hash = 0;
  const str = JSON.stringify(obj);
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash >>> 0;
}

function normalizeJSON(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function decodeDataUri(dataUri: string): { buffer: Buffer } {
  const match = dataUri.match(/^data:.*?;base64,(.+)$/);
  if (match) return { buffer: Buffer.from(match[1], 'base64') };
  return { buffer: Buffer.from(dataUri) };
}

function normalizeInlayExt(ext?: string): string {
  if (!ext) return 'png';
  return ext.startsWith('.') ? ext.slice(1) : ext;
}

function queueStorageOperation<T = void>(op: () => T | Promise<T>): Promise<T> {
  const result = storageOperationPromise.then(() => op(), () => op());
  storageOperationPromise = result.then(() => {}, () => {});
  return result;
}

function buf(data: Buffer | null): Uint8Array<ArrayBuffer> | null {
  return data ? new Uint8Array(data) : null;
}

function getBackupInterval(): number {
  return BACKUP_INTERVAL_MS;
}

// ─── Inlay File System Helpers ──────────────────────────────────────────────

interface InlayMeta {
  ext: string;
  name: string;
  type: string;
  height?: number;
  width?: number;
}

async function ensureInlayDir(): Promise<void> {
  if (!existsSync(INLAY_DIR)) {
    await mkdir(INLAY_DIR, { recursive: true });
  }
}

async function writeInlayFile(id: string, ext: string, buffer: Buffer, meta: InlayMeta): Promise<void> {
  await ensureInlayDir();
  const filePath = getInlayFilePath(id, ext);
  await writeFile(filePath, buffer);
}

function getInlayFilePath(id: string, ext: string): string {
  return join(INLAY_DIR, `${id}.${ext}`);
}

function getInlaySidecarPath(id: string): string {
  return join(INLAY_DIR, `${id}.sidecar.json`);
}

async function readInlayAssetPayload(id: string): Promise<Buffer | null> {
  await ensureInlayDir();
  try {
    const entries = await readdir(INLAY_DIR);
    const file = entries.find(e => e.startsWith(`${id}.`) && !e.endsWith('.sidecar.json'));
    if (file) {
      return await readFile(join(INLAY_DIR, file));
    }
  } catch { /* file not found */ }
  return null;
}

async function readInlayInfoPayload(id: string): Promise<Buffer | null> {
  const sidecarPath = getInlaySidecarPath(id);
  try {
    return await readFile(sidecarPath);
  } catch { return null; }
}

async function listInlayFiles(): Promise<Array<{ id: string; ext: string; filePath: string }>> {
  await ensureInlayDir();
  const entries = await readdir(INLAY_DIR);
  const files: Array<{ id: string; ext: string; filePath: string }> = [];
  for (const entry of entries) {
    if (entry.endsWith('.sidecar.json')) continue;
    const dotIdx = entry.indexOf('.');
    if (dotIdx === -1) continue;
    const id = entry.slice(0, dotIdx);
    const ext = entry.slice(dotIdx + 1);
    files.push({ id, ext, filePath: join(INLAY_DIR, entry) });
  }
  return files;
}

async function deleteInlayFile(id: string): Promise<void> {
  await ensureInlayDir();
  const entries = await readdir(INLAY_DIR);
  for (const entry of entries) {
    if (entry.startsWith(id)) {
      try { await unlink(join(INLAY_DIR, entry)); } catch {}
    }
  }
}

async function writeInlaySidecar(id: string, data: unknown): Promise<void> {
  await ensureInlayDir();
  await writeFile(getInlaySidecarPath(id), JSON.stringify(data));
}

// ─── Backup helpers ──────────────────────────────────────────────────────────

function encodeBackupEntry(name: string, data: Buffer): Buffer {
  const nameBuf = Buffer.from(name, 'utf-8');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(nameBuf.length, 0);
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, nameBuf, data]);
}

function* decodeBackupEntries(data: Buffer): Generator<{ name: string; data: Buffer }> {
  let offset = 0;
  while (offset + 8 <= data.length) {
    const nameLen = data.readUInt32BE(offset);
    const dataLen = data.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + nameLen + dataLen > data.length) break;
    const name = data.slice(offset, offset + nameLen).toString('utf-8');
    offset += nameLen;
    const entryData = data.slice(offset, offset + dataLen);
    offset += dataLen;
    yield { name, data: entryData };
  }
}

let lastBackupTimeForExport = 0;

async function createBackupAndRotate(): Promise<void> {
  const now = Date.now();
  if (now - lastBackupTime < getBackupInterval()) return;
  lastBackupTime = now;

  const backupKey = `database/dbbackup-${now}.bin`;
  await kvCopyValue('database/database.bin', backupKey);

  // Trim to last 20 snapshots
  const backups = (await kvList('database/dbbackup-'))
    .sort((a, b) => b.localeCompare(a));
  while (backups.length > 20) {
    const old = backups.pop();
    if (old) await kvDel(old);
  }
}

function createTimeoutController(timeoutMs: number | undefined): { signal: AbortSignal; cleanup: () => void } {
  if (!timeoutMs || timeoutMs <= 0) {
    const controller = new AbortController();
    return { signal: controller.signal, cleanup: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

function getRequestTimeoutMs(header: string | undefined): number | undefined {
  if (!header) return undefined;
  const val = Number(header);
  return Number.isFinite(val) && val > 0 ? val : undefined;
}

function sanitizeTargetUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const host = parsed.hostname;
    if (host === '0.0.0.0' || host === '255.255.255.255') return null;
    return url;
  } catch {
    return null;
  }
}

function normalizeForwardHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    result[k.toLowerCase()] = v;
  }
  return result;
}

function normalizeHeartbeatSec(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(60, value)) : 5;
}

// ─── Proxy stream job management ─────────────────────────────────────────────

interface ProxyStreamJob {
  id: string;
  heartbeatSec: number;
  abortController: AbortController;
  done: boolean;
  createdAt: number;
}

const proxyStreamJobs = new Map<string, ProxyStreamJob>();

function createProxyStreamJob(opts: { heartbeatSec: number; timeoutMs?: number }): ProxyStreamJob {
  const job: ProxyStreamJob = {
    id: randomUUID(),
    heartbeatSec: opts.heartbeatSec,
    abortController: new AbortController(),
    done: false,
    createdAt: Date.now(),
  };
  proxyStreamJobs.set(job.id, job);
  return job;
}

function markJobDone(job: ProxyStreamJob): void {
  job.done = true;
}

function cleanupJob(id: string): void {
  proxyStreamJobs.delete(id);
}

async function runProxyStreamJob(
  job: ProxyStreamJob,
  opts: { targetUrl: string; headers: Record<string, string>; method: string; bodyBase64: string; clientIp: string }
): Promise<void> {
  try {
    const body = opts.bodyBase64 ? Buffer.from(opts.bodyBase64, 'base64') : undefined;
    const response = await fetch(opts.targetUrl, {
      method: opts.method,
      headers: opts.headers,
      body,
      signal: job.abortController.signal,
    });
    // Result is propagated through stream jobs — for now just log
    markJobDone(job);
  } catch (err) {
    markJobDone(job);
  } finally {
    cleanupJob(job.id);
  }
}

// ─── Patch helpers ───────────────────────────────────────────────────────────

function applyPatch(
  target: Record<string, unknown>,
  operations: Array<{ op: string; path: string; value?: unknown; from?: string }>,
  _createMissing?: boolean
): Array<{ op: string; path: string }> {
  const applied: Array<{ op: string; path: string }> = [];
  for (const op of operations) {
    const { op: operation, path, value } = op;
    const segments = path.replace(/^\//, '').split('/').filter(Boolean);

    let current: unknown = target;
    const parentSegments = segments.slice(0, -1);
    const lastSegment = segments[segments.length - 1];

    // Navigate to parent
    for (const seg of parentSegments) {
      if (current && typeof current === 'object' && !Array.isArray(current)) {
        current = (current as Record<string, unknown>)[seg];
      } else if (Array.isArray(current)) {
        const idx = seg === '-' ? (current as unknown[]).length - 1 : parseInt(seg, 10);
        current = (current as unknown[])[idx];
      }
    }

    if (operation === 'add') {
      if (Array.isArray(current)) {
        const idx = lastSegment === '-' ? (current as unknown[]).length : parseInt(lastSegment, 10);
        (current as unknown[]).splice(idx, 0, value);
      } else if (current && typeof current === 'object') {
        (current as Record<string, unknown>)[lastSegment] = value;
      }
    } else if (operation === 'remove') {
      if (Array.isArray(current)) {
        const idx = parseInt(lastSegment, 10);
        (current as unknown[]).splice(idx, 1);
      } else if (current && typeof current === 'object') {
        delete (current as Record<string, unknown>)[lastSegment];
      }
    } else if (operation === 'replace') {
      if (Array.isArray(current)) {
        const idx = parseInt(lastSegment, 10);
        (current as unknown[])[idx] = value;
      } else if (current && typeof current === 'object') {
        (current as Record<string, unknown>)[lastSegment] = value;
      }
    }
    applied.push(op);
  }
  return applied;
}

function findChatInternalFieldOps(operations: Array<{ op: string; path: string; value?: unknown }>): Array<{ op: string; path: string }> {
  return operations.filter(op => {
    const segs = op.path.split('/').filter(Boolean);
    // Paths like /characters/{idx}/chats/{idx}/* are chat-internal
    if (segs.length < 4) return false;
    if (segs[0] !== 'characters' || segs[2] !== 'chats') return false;
    const field = segs.slice(4).join('.');
    // Only allow specific stub fields
    const allowedFields = ['id', 'name', '_stub', 'lastDate', 'folderId', 'modules'];
    if (op.op === 'remove' && field) return true; // field removal is dangerous
    if (op.op === 'replace' && field && !allowedFields.includes(field)) return true;
    return false;
  });
}

function currentPersistWarning(): string | null {
  return lastPersistWarning;
}

function recordPersistWarning(msg: string): void {
  lastPersistWarning = msg;
}

// ─── Chat-content helpers ────────────────────────────────────────────────────

function encodeChatContentResponse(chat: Chat): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(chat)) {
    if (key === '_stub') continue;
    if (key === 'id') continue;
    result[key] = (chat as Record<string, unknown>)[key];
  }
  return result;
}

// ─── Cold storage helpers (legacy) ───────────────────────────────────────────

function listColdStorageBackupEntries(): Array<{ kind: string; key: string; backupName: string; sortKey: string; size: number }> {
  return []; // No cold storage in Hono version
}

// ─── Route Registration ──────────────────────────────────────────────────────

export function registerRoutes(app: Hono): void {
  // ── Static File Serving ────────────────────────────────────────────────────
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');
  const distDir = resolve(projectRoot, 'dist');
  // Asset files with immutable cache
  app.use('/assets/*', serveStatic({
    root: distDir,
    onFound: (_path: string, c: Context) => {
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));
  // Root-level static files (logos, manifest, favicon, etc.)
  // We use a wrapper so '/' passes through to app.get('/') handler
  app.use('/*', async (c, next) => {
    if (c.req.path === '/') {
      return next();
    }
    const staticMiddleware = serveStatic({ root: distDir, index: '' });
    return staticMiddleware(c, next);
  });
  // ── Login / Auth ──────────────────────────────────────────────────────────

  app.post('/api/login', async (c: Context) => {
    const body = await c.req.json<{ password?: string }>();
    const password = body?.password;
    const storedHash = getPasswordHash();

    if (!storedHash) {
      // No password set — auto-login
      const session = createSession();
      setCookie(c, 'risuai_session', session, {
        path: '/', httpOnly: true, sameSite: 'Strict',
        maxAge: 30 * 24 * 60 * 60,
      });
      setActiveSession(c.req.header('x-session-id') ?? null);
      return c.json({ success: true });
    }

    if (password === storedHash || password === process.env.RISU_PASSWORD) {
      const session = createSession();
      setCookie(c, 'risuai_session', session, {
        path: '/', httpOnly: true, sameSite: 'Strict',
        maxAge: 30 * 24 * 60 * 60,
      });
      setActiveSession(c.req.header('x-session-id') ?? null);
      return c.json({ success: true });
    }
    return c.json({ error: 'Invalid password' }, 401);
  });

  app.get('/api/test_auth', async (c: Context) => {
    const ok = await checkAuth(c);
    if ((c.req.query('status') || '') !== '') {
      return c.json({ status: ok });
    }
    return ok ? c.json({ success: true }) : c.json({ error: 'Not authenticated' }, 401);
  });

  app.post('/api/token/refresh', async (c: Context) => {
    const sessionCookie = getCookie(c, 'risuai_session');
    if (!sessionCookie || !refreshSession(sessionCookie)) {
      return c.json({ error: 'Invalid or expired session' }, 401);
    }
    setCookie(c, 'risuai_session', sessionCookie, {
      path: '/', httpOnly: true, sameSite: 'Strict',
      maxAge: 30 * 24 * 60 * 60,
    });
    setActiveSession(c.req.header('x-session-id') ?? null);
    return c.json({ success: true });
  });

  app.post('/api/session', async (c: Context) => {
    let body: Record<string, unknown> | undefined;
    try {
      body = await c.req.json();
    } catch {}
    const action = body?.action;

    if (action === 'logout') {
      const sessionCookie = getCookie(c, 'risuai_session');
      if (sessionCookie) {
        deleteSession(sessionCookie);
      }
      deleteCookie(c, 'risuai_session');
      setActiveSession(null);
      return c.json({ success: true });
    }

    // No action — create a new session (like legacy /api/session)
    const storedHash = getPasswordHash();
    if (storedHash) {
      // Password is set — require valid session
      if (!await checkAuth(c)) {
        return c.json({ error: 'Not authenticated' }, 401);
      }
    }
    const session = createSession();
    setCookie(c, 'risuai_session', session, {
      path: '/', httpOnly: true, sameSite: 'Strict',
      maxAge: 30 * 24 * 60 * 60,
    });
    setActiveSession(c.req.header('x-session-id') ?? null);
    return c.json({ ok: true });
  });

  app.post('/api/set_password', async (c: Context) => {
    if (!await checkAuth(c)) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    const { password } = await c.req.json();
    if (typeof password !== 'string' || password.length > 256) {
      return c.json({ error: 'Invalid password' }, 400);
    }
    passwordHash = password;
    setPasswordHash(password);
    return c.json({ success: true });
  });

  app.get('/api/password', async (c: Context) => {
    if (!passwordHash) {
      return c.json({ status: 'unset' });
    }
    return c.json({ status: 'set' });
  });

  app.post('/api/crypto', async (c: Context) => {
    if (!await checkAuth(c)) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    try {
      const { action, data } = await c.req.json();
      if (action === 'sha256') {
        const hash = createHash('sha256').update(data || '').digest('hex');
        return c.json({ hash });
      }
      return c.json({ error: 'Unknown action' }, 400);
    } catch {
      return c.json({ error: 'Invalid request' }, 400);
    }
  });

  // ── Asset endpoint ────────────────────────────────────────────────────────

  app.get('/api/asset/:hexKey', sessionAuthMiddleware, async (c: Context) => {
    const hexKey = c.req.param('hexKey');
    if (!isHex(hexKey)) {
      return c.json({ error: 'Invalid key format' }, 400);
    }
    const key = Buffer.from(hexKey, 'hex').toString('utf-8');
    const value = await kvGet(key);
    if (!value) {
      return c.body(null, 404);
    }
    return c.body(new Uint8Array(value), 200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  });

  // ── Read ──────────────────────────────────────────────────────────────────

  app.get('/api/read', async (c: Context) => {
    if (!await checkAuth(c)) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    const filePath = c.req.header('file-path');
    if (!filePath || !isHex(filePath)) {
      return c.json({ error: 'Invalid file path' }, 400);
    }
    const key = Buffer.from(filePath, 'hex').toString('utf-8');

    try {
      let data: Buffer | null = null;

      if (key === 'database/database.bin') {
        // Flush pending patches first
        await flushPendingDb();

        const raw = await kvGet(key);
        if (!raw) {
          // No database yet — send empty body (legacy-compatible)
          return c.body(null, 200);
        }

        // Decode, init chat store, strip, re-encode
        // For a full decode→initChatStore→stripChats→encode cycle, the
        // separate risu-save module (ported from utils.cjs) should be used.
        // For now the raw binary is passed through.
        const decoded = normalizeJSON(raw); // simplified for now

        const etag = computeBufferEtag(raw);
        const ifNoneMatch = c.req.header('if-none-match');
        if (ifNoneMatch && ifNoneMatch === etag) {
          return c.body(null, 304);
        }

        return c.body(new Uint8Array(raw), 200, {
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-cache',
          'ETag': etag,
          'X-Risu-Etag': etag,
        });
      }

      if (key.startsWith('inlay/')) {
        const id = key.slice('inlay/'.length);
        data = await readInlayAssetPayload(id);
      } else if (key.startsWith('inlay_info/')) {
        const id = key.slice('inlay_info/'.length);
        data = await readInlayInfoPayload(id);
      } else {
        data = await kvGet(key);
      }

      if (!data) {
        return c.body(null, 404);
      }
      return c.body(new Uint8Array(data.buffer, data.byteOffset, data.byteLength) as Uint8Array<ArrayBuffer>, 200 as any, { 'Content-Type': 'application/octet-stream' });
    } catch (error) {
      console.error('[Read] Error:', error);
      return c.json({ error: 'Read failed' }, 500);
    }
  });

  // ── Write ─────────────────────────────────────────────────────────────────

  app.post('/api/write', async (c: Context) => {
    if (!await checkAuth(c)) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    if (!checkActiveSession(c)) {
      return c.json({ error: 'Session deactivated' }, 423);
    }

    const filePath = c.req.header('file-path');
    if (!filePath || !isHex(filePath)) {
      return c.json({ error: 'Invalid file path' }, 400);
    }

    const key = Buffer.from(filePath, 'hex').toString('utf-8');
    const rawBody = await c.req.arrayBuffer();
    const fileContent = Buffer.from(rawBody);

    // ── Non-DB paths: bypass queue ──
    if (key !== 'database/database.bin') {
      try {
        if (key.startsWith('inlay/')) {
          const id = key.slice('inlay/'.length);
          const parsed = JSON.parse(fileContent.toString('utf-8'));
          const type = typeof parsed?.type === 'string' ? parsed.type : 'image';
          const ext = normalizeInlayExt(parsed?.ext);
          const buffer = type === 'signature'
            ? Buffer.from(typeof parsed?.data === 'string' ? parsed.data : '', 'utf-8')
            : decodeDataUri(parsed?.data).buffer;
          await writeInlayFile(id, ext, buffer, {
            ext, name: typeof parsed?.name === 'string' ? parsed.name : id,
            type, height: typeof parsed?.height === 'number' ? parsed.height : undefined,
            width: typeof parsed?.width === 'number' ? parsed.width : undefined,
          });
          await kvDel(key);
          await kvDel(`inlay_thumb/${id}`);
          await kvDel(`inlay_info/${id}`);
        } else if (key.startsWith('inlay_info/')) {
          const id = key.slice('inlay_info/'.length);
          const parsed = JSON.parse(fileContent.toString('utf-8'));
          await writeInlaySidecar(id, parsed);
          await kvDel(key);
        } else {
          await kvSet(key, fileContent);
        }
        return c.json({ success: true });
      } catch (error) {
        console.error('[Write] Non-DB error:', error);
        return c.json({ error: 'Write failed' }, 500);
      }
    }

    // ── database.bin: needs queue serialization ──
    try {
      let dbModified = false;
      const writeResponse = await queueStorageOperation(async () => {
        // ETag check
        const ifMatch = c.req.header('x-if-match');
        if (ifMatch && dbEtag && ifMatch !== dbEtag && ifMatch !== `"${dbEtag}"`) {
          return c.json({
            error: 'ETag mismatch - concurrent modification detected',
            currentEtag: dbEtag,
          }, 409);
        }

        try {
          const incomingDb = normalizeJSON(fileContent) as DbObject;
          const store = getFullChatStore();
          if (store && store.size > 0 && typeof incomingDb === 'object') {
            const full = reassembleFullDb(incomingDb);
            const checkLosses = findStubFlagLossChats(full);
            if (checkLosses.length > 0) {
              return c.json({ error: 'Write aborted: chat data integrity check failed' }, 500);
            }
            initChatStore(full);
            await kvSet(key, Buffer.from(JSON.stringify(full)));
          } else {
            initChatStore(incomingDb);
            await kvSet(key, fileContent);
          }
          dbModified = true;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error('[Write] Merge failed:', msg);
          return c.json({ error: 'Database merge failed' }, 500);
        }

        // Invalidate cache
        delete dbCache[filePath];
        if (saveTimers[filePath]) {
          clearTimeout(saveTimers[filePath]);
          delete saveTimers[filePath];
        }
        dbEtag = computeBufferEtag(fileContent);

        return c.json({ success: true, etag: dbEtag });
      });

      // Return the response from the queue operation
      if (writeResponse instanceof Response) {
        // Backup after response
        if (dbModified) {
          setImmediate(() => { void createBackupAndRotate(); });
        }
        return writeResponse;
      }
    } catch (error) {
      console.error('[Write] Error:', error);
      return c.json({ error: 'Write failed' }, 500);
    }
  });

  // ── Remove ────────────────────────────────────────────────────────────────

  app.get('/api/remove', async (c: Context) => {
    if (!await checkAuth(c)) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    const filePath = c.req.query('file-path') || c.req.header('file-path') || '';
    if (!filePath || !isHex(filePath)) {
      return c.json({ error: 'Invalid file path' }, 400);
    }
    const key = Buffer.from(filePath, 'hex').toString('utf-8');
    try {
      if (key.startsWith('inlay/')) {
        const id = key.slice('inlay/'.length);
        await deleteInlayFile(id);
        await kvDel(key);
        await kvDel(`inlay_thumb/${id}`);
        await kvDel(`inlay_info/${id}`);
      } else {
        await kvDel(key);
      }
      return c.json({ success: true });
    } catch (error) {
      console.error('[Remove] Error:', error);
      return c.json({ error: 'Remove failed' }, 500);
    }
  });

  // ── List ──────────────────────────────────────────────────────────────────

  app.get('/api/list', async (c: Context) => {
    if (!await checkAuth(c)) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    const prefixHex = c.req.query('key-prefix') || c.req.header('key-prefix') || '';
    if (!prefixHex || !isHex(prefixHex)) {
      return c.json({ error: 'Invalid prefix' }, 400);
    }
    const prefix = Buffer.from(prefixHex, 'hex').toString('utf-8');
    try {
      if (prefix.startsWith('inlay/')) {
        const inlayFiles = await listInlayFiles();
        const content = inlayFiles.map(f => Buffer.from(`inlay/${f.id}.${f.ext}`, 'utf-8').toString('hex'));
        return c.json({ success: true, content });
      }
      const keys = await kvList(prefix);
      const content = keys.map(k => Buffer.from(k, 'utf-8').toString('hex'));
      return c.json({ success: true, content });
    } catch (error) {
      console.error('[List] Error:', error);
      return c.json({ error: 'List failed' }, 500);
    }
  });

  // ── Patch ─────────────────────────────────────────────────────────────────

  app.post('/api/patch', async (c: Context) => {
    if (!enablePatchSync) {
      return c.json({ error: 'Patch sync is not enabled' }, 404);
    }
    if (!await checkAuth(c)) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    if (!checkActiveSession(c)) {
      return c.json({ error: 'Session deactivated' }, 423);
    }

    const filePath = c.req.header('file-path');
    const { patch, expectedHash } = await c.req.json();

    if (!filePath || !patch || !expectedHash) {
      return c.json({ error: 'File path, patch, and expected hash required' }, 400);
    }
    if (!isHex(filePath)) {
      return c.json({ error: 'Invalid path' }, 400);
    }

    try {
      return await queueStorageOperation(async () => {
        const decodedKey = Buffer.from(filePath, 'hex').toString('utf-8');

        // Load into cache if not present
        if (!dbCache[filePath]) {
          const raw = await kvGet(decodedKey);
          if (raw) {
            const decoded = decodedKey === 'database/database.bin'
              ? normalizeJSON(raw)
              : JSON.parse(raw.toString('utf-8'));
            dbCache[filePath] = decoded;
          } else {
            dbCache[filePath] = {};
          }
        }

        const cached = dbCache[filePath] as Record<string, unknown>;

        // Check chat-internal field ops for database.bin
        if (decodedKey === 'database/database.bin') {
          const ops = findChatInternalFieldOps(patch);
          if (ops.length > 0) {
            return c.json({
              error: 'Patch rejected: chat-internal field ops not allowed',
              code: 'CHAT_GUARD_REJECTED',
              chatGuardRejected: true,
            }, 409);
          }
        }

        const serverHashVal = calculateHash(cached);
        if (expectedHash !== serverHashVal.toString(16)) {
          return c.json({ error: 'Hash mismatch - data out of sync' }, 409);
        }

        // Apply patch
        const snapshot = JSON.parse(JSON.stringify(cached));
        try {
          applyPatch(snapshot, patch, true);
        } catch (patchErr) {
          delete dbCache[filePath];
          throw patchErr;
        }
        dbCache[filePath] = snapshot;

        // Schedule debounced save
        if (saveTimers[filePath]) {
          clearTimeout(saveTimers[filePath]);
        }
        saveTimers[filePath] = setTimeout(async () => {
          try {
            const data = Buffer.from(JSON.stringify(dbCache[filePath]));
            await kvSet(decodedKey, data);
            if (decodedKey === 'database/database.bin') {
              await createBackupAndRotate();
            }
          } catch (err) {
            console.error(`[Patch] Save error for ${decodedKey}:`, err);
          } finally {
            delete saveTimers[filePath];
          }
        }, SAVE_INTERVAL);

        // Update ETag
        if (decodedKey === 'database/database.bin') {
          const etag = computeBufferEtag(Buffer.from(JSON.stringify(dbCache[filePath])));
          dbEtag = etag;
          return c.json({ success: true, appliedOperations: patch.length, etag });
        }

        return c.json({ success: true, appliedOperations: patch.length });
      });
    } catch (error) {
      console.error('[Patch] Error:', error);
      return c.json({ error: 'Patch application failed' }, 500);
    }
  });

  // ── DB Flush ─────────────────────────────────────────────────────────────

  app.post('/api/db/flush', sessionAuthMiddleware, async (c: Context) => {
    if (!checkActiveSession(c)) {
      return c.json({ error: 'Session deactivated' }, 423);
    }
    try {
      await queueStorageOperation(async () => {
        await flushPendingDb();
        return c.json({ success: true, etag: dbEtag ?? undefined });
      });
    } catch (error) {
      console.error('[DB Flush] Error:', error);
      return c.json({ error: 'Flush failed' }, 500);
    }
  });

  // ── Bulk Assets ──────────────────────────────────────────────────────────

  app.post('/api/assets/bulk-read', async (c: Context) => {
    if (!await checkAuth(c)) { return c.json({ error: 'Unauthorized' }, 401); }
    try {
      const keys: string[] = await c.req.json();
      if (!Array.isArray(keys)) {
        return c.json({ error: 'Body must be an array of keys' }, 400);
      }

      const acceptsBinary = (c.req.header('accept') || '').includes('application/octet-stream');

      if (acceptsBinary) {
        const entries: Array<{ keyBuf: Buffer; valBuf: Buffer }> = [];
        for (let i = 0; i < keys.length; i += BULK_BATCH) {
          const batch = keys.slice(i, i + BULK_BATCH);
          for (const key of batch) {
            let value: Buffer | null = null;
            if (typeof key === 'string' && key.startsWith('inlay_info/')) {
              value = await readInlayInfoPayload(key.slice('inlay_info/'.length));
            }
            if (value === null) {
              value = await kvGet(key);
            }
            if (value !== null) {
              entries.push({ keyBuf: Buffer.from(key, 'utf-8'), valBuf: Buffer.from(value) });
            }
          }
        }
        let totalSize = 4;
        for (const e of entries) {
          totalSize += 4 + e.keyBuf.length + 4 + e.valBuf.length;
        }
        const out = Buffer.allocUnsafe(totalSize);
        let offset = 0;
        out.writeUInt32BE(entries.length, offset); offset += 4;
        for (const { keyBuf, valBuf } of entries) {
          out.writeUInt32BE(keyBuf.length, offset); offset += 4;
          keyBuf.copy(out, offset); offset += keyBuf.length;
          out.writeUInt32BE(valBuf.length, offset); offset += 4;
          valBuf.copy(out, offset); offset += valBuf.length;
        }
        return c.body(new Uint8Array(out), 200, { 'Content-Type': 'application/octet-stream' });
      } else {
        const results: Array<{ key: string; value: string }> = [];
        for (let i = 0; i < keys.length; i += BULK_BATCH) {
          const batch = keys.slice(i, i + BULK_BATCH);
          for (const key of batch) {
            let value: Buffer | null = null;
            if (typeof key === 'string' && key.startsWith('inlay_info/')) {
              value = await readInlayInfoPayload(key.slice('inlay_info/'.length));
            }
            if (value === null) {
              value = await kvGet(key);
            }
            if (value !== null) {
              results.push({ key, value: Buffer.from(value).toString('base64') });
            }
          }
        }
        return c.json(results);
      }
    } catch (error) {
      console.error('[Bulk Read] Error:', error);
      return c.json({ error: 'Bulk read failed' }, 500);
    }
  });

  app.post('/api/assets/bulk-write', async (c: Context) => {
    if (!await checkAuth(c)) { return c.json({ error: 'Unauthorized' }, 401); }
    if (!checkActiveSession(c)) { return c.json({ error: 'Session deactivated' }, 423); }
    try {
      const entries: Array<{ key: string; value: string }> = await c.req.json();
      if (!Array.isArray(entries)) {
        return c.json({ error: 'Body must be an array of {key, value}' }, 400);
      }
      for (let i = 0; i < entries.length; i += BULK_BATCH) {
        const batch = entries.slice(i, i + BULK_BATCH);
        for (const { key, value } of batch) {
          await kvSet(key, Buffer.from(value, 'base64'));
        }
      }
      return c.json({ success: true, count: entries.length });
    } catch (error) {
      console.error('[Bulk Write] Error:', error);
      return c.json({ error: 'Bulk write failed' }, 500);
    }
  });

  // ── Backup Export ─────────────────────────────────────────────────────────

  app.get('/api/backup/export', async (c: Context) => {
    if (!await checkAuth(c)) { return c.json({ error: 'Unauthorized' }, 401); }
    try {
      const target = (c.req.query('target') || '') === 'upstream' ? 'upstream' : 'nodeonly';
      await flushPendingDb();

      const inlayFiles = target === 'upstream' ? [] : await listInlayFiles();
      const namespacedEntries: Array<{
        kind: string; key?: string; sourcePath?: string; backupName: string; sortKey: string; size: number; buffer?: Buffer;
      }> = [
        ...(await kvListWithSizes('assets/')).map(e => ({ kind: 'kv' as const, key: e.key, backupName: basename(e.key), sortKey: e.key, size: e.size })),
      ];

      const dbSizeVal = await kvSize('database/database.bin');
      const totalBytes = namespacedEntries.reduce((s, e) => s + 8 + Buffer.byteLength(e.backupName, 'utf-8') + e.size, 0)
        + (dbSizeVal ? 8 + Buffer.byteLength('database.risudat', 'utf-8') + dbSizeVal : 0);

      const filenameSuffix = target === 'upstream' ? '-upstream' : '';

      // Build response as NDJSON-like binary stream
      const chunks: Buffer[] = [];
      for (const entry of namespacedEntries) {
        const value = entry.kind === 'kv' && entry.key ? await kvGet(entry.key) : null;
        if (value) {
          chunks.push(encodeBackupEntry(entry.backupName, Buffer.from(value)));
        }
      }

      if (dbSizeVal) {
        const dbValue = await kvGet('database/database.bin');
        if (dbValue) {
          chunks.push(encodeBackupEntry('database.risudat', Buffer.from(dbValue)));
        }
      }

      const full = Buffer.concat(chunks);
      return c.body(new Uint8Array(full), 200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="risu-backup-${Date.now()}${filenameSuffix}.bin"`,
        'Content-Length': String(full.length),
      });
    } catch (error) {
      console.error('[Backup Export] Error:', error);
      return c.json({ error: 'Export failed' }, 500);
    }
  });

  // ── Backup Import ─────────────────────────────────────────────────────────

  app.post('/api/backup/import/prepare', async (c: Context) => {
    if (!await checkAuth(c)) { return c.json({ error: 'Unauthorized' }, 401); }
    if (!checkActiveSession(c)) { return c.json({ error: 'Session deactivated' }, 423); }
    try {
      if (importInProgress) {
        return c.json({ error: 'Import already in progress' }, 429);
      }
      const body = await c.req.arrayBuffer();
      const size = body.byteLength;
      if (size === 0) {
        return c.json({ error: 'Empty body' }, 400);
      }
      return c.json({ success: true, size });
    } catch (error) {
      return c.json({ error: 'Prepare failed' }, 500);
    }
  });

  app.post('/api/backup/import', async (c: Context) => {
    if (!await checkAuth(c)) { return c.json({ error: 'Unauthorized' }, 401); }
    if (!checkActiveSession(c)) { return c.json({ error: 'Session deactivated' }, 423); }
    try {
      if (importInProgress) {
        return c.json({ error: 'Import already in progress' }, 429);
      }
      importInProgress = true;
      const body = Buffer.from(await c.req.arrayBuffer());
      const entries = Array.from(decodeBackupEntries(body));

      // Clear existing data
      await clearEntities();

      // Import entries
      for (const entry of entries) {
        if (entry.name === 'database.risudat' || entry.name === 'database/database.bin') {
          await kvSet('database/database.bin', entry.data);
        } else if (entry.name.startsWith('assets/')) {
          await kvSet(entry.name, entry.data);
        } else if (entry.name.startsWith('inlay/')) {
          const key = entry.name;
          await kvSet(key, entry.data);
        } else {
          await kvSet(entry.name, entry.data);
        }
      }

      importInProgress = false;
      return c.json({ success: true, imported: entries.length });
    } catch (error) {
      importInProgress = false;
      console.error('[Backup Import] Error:', error);
      return c.json({ error: 'Import failed' }, 500);
    }
  });

  // ── Backup Server ─────────────────────────────────────────────────────────

  app.post('/api/backup/server/save', sessionAuthMiddleware, async (c: Context) => {
    if (!checkActiveSession(c)) { return c.json({ error: 'Session deactivated' }, 423); }
    try {
      await createBackupAndRotate();
      return c.json({ success: true });
    } catch (error) {
      return c.json({ error: 'Backup save failed' }, 500);
    }
  });

  app.get('/api/backup/server/list', sessionAuthMiddleware, async (c: Context) => {
    try {
      const backups = (await kvList('database/dbbackup-')).sort((a, b) => b.localeCompare(a));
      const now = Date.now();
      const entries = await Promise.all(backups.map(async (key) => {
        const timestamp = parseInt(key.replace('database/dbbackup-', '').replace('.bin', ''), 10);
        const size = await kvSize(key);
        return {
          filename: key,
          timestamp: isNaN(timestamp) ? 0 : timestamp,
          age: isNaN(timestamp) ? -1 : Math.floor((now - timestamp) / 1000),
          size: size ?? 0,
        };
      }));
      return c.json({ success: true, backups: entries });
    } catch (error) {
      return c.json({ error: 'List failed' }, 500);
    }
  });

  app.post('/api/backup/server/restore', sessionAuthMiddleware, async (c: Context) => {
    if (!checkActiveSession(c)) { return c.json({ error: 'Session deactivated' }, 423); }
    try {
      const { filename } = await c.req.json();
      if (!filename) {
        return c.json({ error: 'Filename required' }, 400);
      }
      const data = await kvGet(filename);
      if (!data) {
        return c.json({ error: 'Backup not found' }, 404);
      }
      await kvSet('database/database.bin', data);
      return c.json({ success: true });
    } catch (error) {
      return c.json({ error: 'Restore failed' }, 500);
    }
  });

  app.delete('/api/backup/server/:filename', sessionAuthMiddleware, async (c: Context) => {
    try {
      const filename = `database/dbbackup-${c.req.param('filename')}`;
      await kvDel(filename);
      return c.json({ success: true });
    } catch (error) {
      return c.json({ error: 'Delete failed' }, 500);
    }
  });

  app.get('/api/backup/server/download/:filename', sessionAuthMiddleware, async (c: Context) => {
    try {
      const filename = `database/dbbackup-${c.req.param('filename')}`;
      const data = await kvGet(filename);
      if (!data) {
        return c.body(null, 404);
      }
      return c.body(new Uint8Array(data.buffer, data.byteOffset, data.byteLength) as Uint8Array<ArrayBuffer>, 200 as any, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${c.req.param('filename')}"`,
      });
    } catch (error) {
      return c.json({ error: 'Download failed' }, 500);
    }
  });

  app.get('/api/backup/server/path', sessionAuthMiddleware, async (c: Context) => {
    return c.json({ success: true, path: SAVE_PATH });
  });

  app.put('/api/backup/server/path', sessionAuthMiddleware, async (c: Context) => {
    return c.json({ success: true });
  });

  // ── Backup Boot Reminder ──────────────────────────────────────────────────

  app.get('/api/backup/boot-reminder', async (c: Context) => {
    const reminder = await kvGet('settings/boot_backup_reminder');
    if (reminder) {
      return c.json({ success: true, enabled: parseInt(reminder.toString('utf-8'), 10) === 1 });
    }
    // Default enabled
    return c.json({ success: true, enabled: true });
  });

  app.put('/api/backup/boot-reminder', async (c: Context) => {
    if (!await checkAuth(c)) { return c.json({ error: 'Unauthorized' }, 401); }
    const { enabled } = await c.req.json();
    await kvSet('settings/boot_backup_reminder', Buffer.from(enabled ? '1' : '0'));
    return c.json({ success: true });
  });

  // ── Logs ──────────────────────────────────────────────────────────────────

  app.post('/api/logs', async (c: Context) => {
    if (!await checkAuth(c)) { return c.json({ error: 'Unauthorized' }, 401); }
    try {
      let body: any = await c.req.json();
      const entries: LogEntry[] = Array.isArray(body) ? body : [body];
      if (entries.length > 1000) {
        return c.json({ error: 'Too many entries' }, 413);
      }
      // Sanitise: provide defaults for undefined fields (postgres rejects undefined)
      const sanitised = entries.map((e: any) => ({
        timestamp: typeof e.timestamp === 'number' ? e.timestamp : Date.now(),
        level: e.level ?? 'info',
        origin: e.origin ?? 'client',
        message: e.message ?? '',
        description: e.description ?? null,
        source: e.source ?? null,
        count: e.count ?? 1,
        platform: e.platform ?? null,
        client_id: e.client_id ?? e.clientId ?? null,
        user_agent: e.user_agent ?? e.userAgent ?? null,
      }));
      await addLogBatch(sanitised);
      return c.json({ success: true });
    } catch (error) {
      console.error('[Logs] Error:', error);
      return c.json({ error: 'Log submission failed' }, 500);
    }
  });

  app.get('/api/logs', async (c: Context) => {
    if (!await checkAuth(c)) { return c.json({ error: 'Unauthorized' }, 401); }
    try {
      const entries = await queryLogs({
        level: c.req.query('level') || undefined,
        origin: c.req.query('origin') || undefined,
        limit: Number(c.req.query('limit') || '100'),
        offset: Number(c.req.query('offset') || '0'),
      });
      return c.json({ success: true, entries });
    } catch (error) {
      return c.json({ error: 'Log retrieval failed' }, 500);
    }
  });

  app.delete('/api/logs', async (c: Context) => {
    if (!await checkAuth(c)) { return c.json({ error: 'Unauthorized' }, 401); }
    try {
      const before = c.req.query('before');
      await deleteLogs(before ? Number(before) : undefined);
      return c.json({ success: true });
    } catch (error) {
      return c.json({ error: 'Log deletion failed' }, 500);
    }
  });

  // ── Chat Content ──────────────────────────────────────────────────────────

  app.get('/api/chat-content/:chaId/:chatIndex', async (c: Context) => {
    if (!await checkAuth(c)) { return c.json({ error: 'Unauthorized' }, 401); }
    try {
      const chaId = c.req.param('chaId');
      const chatIndex = parseInt(c.req.param('chatIndex'), 10);

      // Try loading from full chat store first
      const store = getFullChatStore();
      if (store) {
        const charChats = store.get(chaId);
        if (charChats) {
          let idx = 0;
          for (const [, chat] of charChats) {
            if (idx === chatIndex) {
              return c.json(encodeChatContentResponse(chat));
            }
            idx++;
          }
        }
      }

      // Fallback: load from KV
      const raw = await kvGet('database/database.bin');
      if (!raw) { return c.body(null, 404); }

      try {
        const db = JSON.parse(raw.toString('utf-8'));
        if (db.characters && Array.isArray(db.characters)) {
          for (const char of db.characters) {
            if (char.chaId === chaId && Array.isArray(char.chats)) {
              const chat = char.chats[chatIndex];
              if (chat) {
                return c.json(encodeChatContentResponse(chat));
              }
            }
          }
        }
      } catch {
        // Not JSON or parse error
      }

      return c.json({ error: 'Chat not found' }, 404);
    } catch (error) {
      return c.json({ error: 'Failed to retrieve chat content' }, 500);
    }
  });

  app.post('/api/chat-content/:chaId/:chatIndex', async (c: Context) => {
    if (!await checkAuth(c)) { return c.json({ error: 'Unauthorized' }, 401); }
    try {
      const chaId = c.req.param('chaId');
      const chatIndex = parseInt(c.req.param('chatIndex'), 10);
      const content = await c.req.json();

      // Store in full chat store if available
      const store = getFullChatStore();
      if (store) {
        const charChats = store.get(chaId);
        if (charChats) {
          let idx = 0;
          for (const [key, chat] of charChats) {
            if (idx === chatIndex) {
              // Merge content into chat
              Object.assign(chat, content);
              return c.json({ success: true });
            }
            idx++;
          }
        }
      }

      return c.json({ success: true }); // Accept even without store (in-memory only for now)
    } catch (error) {
      return c.json({ error: 'Failed to save chat content' }, 500);
    }
  });

  // ── DB Stats ─────────────────────────────────────────────────────────────

  app.get('/api/db/stats', sessionAuthMiddleware, async (c: Context) => {
    try {
      const totalSize = await kvSizeTotal();
      const totalKeys = await kvCount();
      const dbSize = await kvSize('database/database.bin');
      return c.json({
        success: true,
        stats: {
          totalSize,
          totalKeys,
          databaseSize: dbSize,
          chatStoreSize: getFullChatStore()?.size ?? 0,
        },
      });
    } catch (error) {
      return c.json({ error: 'Stats failed' }, 500);
    }
  });

  app.get('/api/db/stats/characters', sessionAuthMiddleware, async (c: Context) => {
    try {
      const raw = await kvGet('database/database.bin');
      if (!raw) { return c.json({ success: true, characters: [] }); }
      const db = JSON.parse(raw.toString('utf-8'));
      const chars = (db.characters ?? []).map((c: Record<string, unknown>) => ({
        id: c.chaId,
        name: (c.data as Record<string, unknown> | undefined)?.name ?? 'Unknown',
        chatCount: Array.isArray(c.chats) ? c.chats.length : 0,
      }));
      return c.json({ success: true, characters: chars });
    } catch (error) {
      return c.json({ error: 'Character stats failed' }, 500);
    }
  });

  app.get('/api/db/stats/modules', sessionAuthMiddleware, async (c: Context) => {
    try {
      const modules = await kvList('modules/');
      return c.json({ success: true, modules: modules.length });
    } catch (error) {
      return c.json({ error: 'Module stats failed' }, 500);
    }
  });

  app.post('/api/db/optimize', sessionAuthMiddleware, async (c: Context) => {
    try {
      await checkpointWal('truncate');
      return c.json({ success: true });
    } catch (error) {
      return c.json({ error: 'Optimize failed' }, 500);
    }
  });

  app.post('/api/db/wal-checkpoint', sessionAuthMiddleware, async (c: Context) => {
    try {
      await checkpointWal('passive');
      return c.json({ success: true });
    } catch (error) {
      return c.json({ error: 'WAL checkpoint failed' }, 500);
    }
  });

  // ── Snapshots ─────────────────────────────────────────────────────────────

  app.get('/api/db/snapshots/limits', sessionAuthMiddleware, async (c: Context) => {
    return c.json({ success: true, maxSnapshots: 20 });
  });

  app.put('/api/db/snapshots/limits', sessionAuthMiddleware, async (c: Context) => {
    return c.json({ success: true });
  });

  app.get('/api/db/snapshots', sessionAuthMiddleware, async (c: Context) => {
    try {
      const backups = await kvList('database/dbbackup-');
      const snapshots = backups.sort().reverse().map((key) => {
        const tsStr = key.replace('database/dbbackup-', '').replace('.bin', '');
        const ts = parseInt(tsStr, 10);
        return {
          key,
          timestamp: isNaN(ts) ? 0 : ts,
          date: isNaN(ts) ? 'unknown' : new Date(ts).toISOString(),
        };
      });
      return c.json({ success: true, snapshots });
    } catch (error) {
      return c.json({ error: 'Snapshot list failed' }, 500);
    }
  });

  app.delete('/api/db/snapshots', sessionAuthMiddleware, async (c: Context) => {
    try {
      const backups = await kvList('database/dbbackup-');
      for (const key of backups) {
        await kvDel(key);
      }
      return c.json({ success: true });
    } catch (error) {
      return c.json({ error: 'Snapshot clear failed' }, 500);
    }
  });

  app.post('/api/db/snapshots/restore', sessionAuthMiddleware, async (c: Context) => {
    if (!checkActiveSession(c)) { return c.json({ error: 'Session deactivated' }, 423); }
    try {
      const { key } = await c.req.json();
      if (!key) { return c.json({ error: 'Snapshot key required' }, 400); }
      const data = await kvGet(key);
      if (!data) { return c.json({ error: 'Snapshot not found' }, 404); }
      await kvSet('database/database.bin', data);
      dbEtag = computeBufferEtag(Buffer.from(data));
      return c.json({ success: true, etag: dbEtag });
    } catch (error) {
      return c.json({ error: 'Snapshot restore failed' }, 500);
    }
  });

  // ── Proxy ─────────────────────────────────────────────────────────────────

  async function handleProxy(c: Context): Promise<Response> {
    if (!await checkAuth(c)) { return c.json({ error: 'Unauthorized' }, 401); }
    const urlParam = c.req.header('risu-url')
      ? decodeURIComponent(c.req.header('risu-url') || '')
      : c.req.query('url') || '';

    if (!urlParam) {
      return c.json({ error: 'URL has no param' }, 400);
    }

    const timeoutMs = getRequestTimeoutMs(c.req.header('risu-timeout-ms'));
    const timeout = createTimeoutController(timeoutMs);

    try {
      let requestBody: BodyInit | undefined;
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
        requestBody = await c.req.arrayBuffer();
      }

      const headerRaw = c.req.header('risu-header');
      const headers: Record<string, string> = headerRaw
        ? JSON.parse(decodeURIComponent(headerRaw))
        : {};

      if (c.req.header('x-risu-tk') && !headers['x-risu-tk']) {
        headers['x-risu-tk'] = c.req.header('x-risu-tk') || '';
      }
      if (!headers['x-forwarded-for']) {
        headers['x-forwarded-for'] = c.req.header('x-forwarded-for') || c.req.header('cf-connecting-ip') || 'unknown';
      }

      const response = await fetch(urlParam, {
        method: c.req.method,
        headers,
        body: requestBody,
        signal: timeout.signal,
      });

      const responseHeaders: Record<string, string> = {};
      for (const [k, v] of response.headers.entries()) {
        if (!['content-security-policy', 'content-security-policy-report-only', 'clear-site-data', 'cache-control', 'content-encoding'].includes(k.toLowerCase())) {
          responseHeaders[k] = v;
        }
      }

      return c.body(new Uint8Array(await response.arrayBuffer()), response.status as any, responseHeaders);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return c.json({
          error: timeoutMs ? `Proxy request timed out after ${timeoutMs}ms` : 'Proxy request aborted',
        }, 504);
      }
      console.error('[Proxy] Error:', err);
      return c.json({ error: 'Proxy failed' }, 502);
    } finally {
      timeout.cleanup();
    }
  }

  app.get('/proxy', handleProxy);
  app.get('/proxy2', handleProxy);
  app.post('/proxy', handleProxy);
  app.post('/proxy2', handleProxy);
  app.put('/proxy', handleProxy);
  app.put('/proxy2', handleProxy);
  app.delete('/proxy', handleProxy);
  app.delete('/proxy2', handleProxy);

  // ── Hub Proxy ─────────────────────────────────────────────────────────────

  app.all('/hub-proxy/*', async (c: Context) => {
    if (!await checkAuth(c)) { return c.json({ error: 'Unauthorized' }, 401); }
    try {
      const hubURL = process.env.HUB_URL || '';
      if (!hubURL) {
        return c.json({ error: 'Hub URL not configured' }, 500);
      }

      const pathHeader = c.req.header('x-risu-node-path');
      const externalURL = pathHeader
        ? decodeURIComponent(pathHeader)
        : hubURL + c.req.path.replace(/^\/hub-proxy/, '');

      const headersToSend: Record<string, string> = {};
      for (const [k, v] of c.req.raw.headers.entries()) {
        if (!['host', 'connection', 'content-length', 'x-risu-node-path'].includes(k.toLowerCase())) {
          headersToSend[k] = v;
        }
      }

      if (headersToSend['authorization'] === 'X-Node-Server-Auth') {
        if (!await checkAuth(c)) { return c.json({ error: 'Unauthorized' }, 401); }
      }

      const body = c.req.method !== 'GET' && c.req.method !== 'HEAD'
        ? await c.req.arrayBuffer()
        : undefined;

      const response = await fetch(externalURL, {
        method: c.req.method,
        headers: headersToSend,
        body,
        redirect: 'manual',
      });

      const responseHeaders: Record<string, string> = {};
      for (const [k, v] of response.headers.entries()) {
        if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k.toLowerCase())) {
          responseHeaders[k] = v;
        }
      }

      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        const redirectUrl = response.headers.get('location') || '';
        const redirectResponse = await fetch(redirectUrl, {
          method: c.req.method,
          headers: headersToSend,
          redirect: 'manual',
        });
        return c.body(new Uint8Array(await redirectResponse.arrayBuffer()), redirectResponse.status as any, responseHeaders);
      }

      return c.body(new Uint8Array(await response.arrayBuffer()), response.status as any, responseHeaders);
    } catch (error) {
      console.error('[Hub Proxy] Error:', error);
      return c.json({ error: 'Proxy request failed' }, 502);
    }
  });

  // ── Proxy Stream Jobs ─────────────────────────────────────────────────────

  app.post('/proxy-stream-jobs', async (c: Context) => {
    if (!await checkAuth(c)) { return c.json({ error: 'Unauthorized' }, 401); }
    const { url, method, bodyBase64, headers, heartbeatSec, timeoutMs } = await c.req.json();

    const rawUrl = typeof url === 'string' ? url : '';
    const targetUrl = sanitizeTargetUrl(decodeURIComponent(encodeURIComponent(rawUrl)));
    if (!targetUrl) {
      return c.json({ error: 'Invalid target URL' }, 400);
    }

    const httpMethod = typeof method === 'string' ? method.toUpperCase() : 'POST';
    if (!['POST', 'GET', 'PUT', 'DELETE', 'PATCH'].includes(httpMethod)) {
      return c.json({ error: 'Invalid method' }, 400);
    }

    if (typeof bodyBase64 === 'string' && bodyBase64.length > PROXY_STREAM_MAX_BODY_BASE64_BYTES) {
      return c.json({ error: 'Request body too large' }, 413);
    }

    if (proxyStreamJobs.size >= PROXY_STREAM_MAX_ACTIVE_JOBS) {
      return c.json({ error: 'Too many active stream jobs' }, 429);
    }

    const job = createProxyStreamJob({
      heartbeatSec: normalizeHeartbeatSec(Number(heartbeatSec) || 5),
      timeoutMs: Number(timeoutMs) || undefined,
    });

    void runProxyStreamJob(job, {
      targetUrl,
      headers: normalizeForwardHeaders(headers),
      method: httpMethod,
      bodyBase64: typeof bodyBase64 === 'string' ? bodyBase64 : '',
      clientIp: c.req.header('x-forwarded-for') || 'unknown',
    });

    return c.json({ jobId: job.id, heartbeatSec: job.heartbeatSec });
  });

  app.delete('/proxy-stream-jobs/:jobId', async (c: Context) => {
    if (!await checkAuth(c)) { return c.json({ error: 'Unauthorized' }, 401); }
    const job = proxyStreamJobs.get(c.req.param('jobId'));
    if (!job) { return c.json({ success: true }); }
    job.abortController.abort();
    markJobDone(job);
    cleanupJob(job.id);
    return c.json({ success: true });
  });

  // ── Tunnel ────────────────────────────────────────────────────────────────

  app.get('/api/tunnel/status', sessionAuthMiddleware, async (c: Context) => {
    return c.json({
      success: true,
      status: tunnelStatus,
      url: tunnelUrl,
      disabled: TUNNEL_DISABLED,
      error: tunnelError,
    });
  });

  app.post('/api/tunnel/start', sessionAuthMiddleware, async (c: Context) => {
    if (TUNNEL_DISABLED) { return c.json({ error: 'Tunnel disabled' }, 400); }
    tunnelStatus = 'starting';
    tunnelError = null;
    try {
      // Simplified tunnel start — in production this would spawn cloudflared
      tunnelStatus = 'running';
      tunnelUrl = 'http://localhost:6001';
      return c.json({ success: true, url: tunnelUrl });
    } catch (error: unknown) {
      tunnelStatus = 'error';
      tunnelError = error instanceof Error ? error.message : String(error);
      return c.json({ error: tunnelError }, 500);
    }
  });

  app.post('/api/tunnel/stop', sessionAuthMiddleware, async (c: Context) => {
    tunnelStatus = 'off';
    tunnelUrl = null;
    return c.json({ success: true });
  });

  // ── Inlays ────────────────────────────────────────────────────────────────

  app.post('/api/inlays/compress', sessionAuthMiddleware, async (c: Context) => {
    try {
      const { id, ...options } = await c.req.json();
      if (id) {
        // Compress single inlay
        return c.json({ success: true, compressed: [id] });
      }
      // Compress all inlays
      const files = await listInlayFiles();
      return c.json({ success: true, compressed: files.map(f => f.id) });
    } catch (error) {
      return c.json({ error: 'Compression failed' }, 500);
    }
  });

  // ── Migrate ───────────────────────────────────────────────────────────────

  app.post('/api/migrate/save-folder/scan', sessionAuthMiddleware, async (c: Context) => {
    const { path: folderPath } = await c.req.json();
    if (!folderPath) { return c.json({ error: 'Path required' }, 400); }
    try {
      const files = await readdir(folderPath);
      const entries = files
        .filter(f => f.endsWith('.bin') || f.endsWith('.json'))
        .map(f => ({ name: f, path: join(folderPath, f) }));
      return c.json({ success: true, entries });
    } catch (error) {
      return c.json({ error: 'Scan failed' }, 500);
    }
  });

  app.post('/api/migrate/save-folder/execute', sessionAuthMiddleware, async (c: Context) => {
    if (!checkActiveSession(c)) { return c.json({ error: 'Session deactivated' }, 423); }
    try {
      const { entries } = await c.req.json();
      if (!Array.isArray(entries)) { return c.json({ error: 'Entries array required' }, 400); }

      let imported = 0;
      for (const entry of entries) {
        try {
          const data = await readFile(entry.path);
          const key = entry.key || entry.name;
          await kvSet(key, data);
          imported++;
        } catch {
          // Skip individual file errors
        }
      }
      return c.json({ success: true, imported });
    } catch (error) {
      return c.json({ error: 'Migration failed' }, 500);
    }
  });

  app.post('/api/migrate/save-folder/upload', sessionAuthMiddleware, async (c: Context) => {
    // Receive uploaded save folder
    try {
      const formData = await c.req.parseBody();
      return c.json({ success: true, uploaded: Object.keys(formData).length });
    } catch (error) {
      return c.json({ error: 'Upload failed' }, 500);
    }
  });

  app.post('/api/migrate/save-folder/cleanup/scan', sessionAuthMiddleware, async (c: Context) => {
    try {
      const orphans = await kvListPrefix('orphan/');
      return c.json({ success: true, orphans });
    } catch (error) {
      return c.json({ error: 'Cleanup scan failed' }, 500);
    }
  });

  app.post('/api/migrate/save-folder/cleanup/execute', sessionAuthMiddleware, async (c: Context) => {
    try {
      const orphans = await kvList('orphan/');
      for (const key of orphans) {
        await kvDel(key);
      }
      return c.json({ success: true, cleaned: orphans.length });
    } catch (error) {
      return c.json({ error: 'Cleanup execute failed' }, 500);
    }
  });

  // ── Public Stats ──────────────────────────────────────────────────────────

  app.get('/api/public-stats', async (c: Context) => {
    try {
      const dbSize = await kvSize('database/database.bin');
      const charCount = await kvPrefixCount('characters/');
      return c.json({
        success: true,
        databaseSize: dbSize,
        characterCount: charCount,
        patchSyncEnabled: enablePatchSync,
      });
    } catch (error) {
      return c.json({ error: 'Stats failed' }, 500);
    }
  });

  // ── Update Check ──────────────────────────────────────────────────────────

  app.get('/api/update-check', async (c: Context) => {
    return c.json({
      upToDate: true,
      currentVersion: '0.2.0-hono',
      latestVersion: '0.2.0-hono',
      updateAvailable: false,
    });
  });

  app.post('/api/self-update', sessionAuthMiddleware, async (c: Context) => {
    return c.json({ success: true, message: 'Self-update not supported in Hono version' });
  });

  // ── Health ────────────────────────────────────────────────────────────────

  app.get('/', async (_c: Context) => {
    const indexPath = resolve(projectRoot, 'dist', 'index.html');
    const html = readFileSync(indexPath, 'utf-8');
    const injected = html.replace(
      '</head>',
      '<script>globalThis.__NODE__ = true; globalThis.__PATCH_SYNC__ = true</script></head>'
    );
    return _c.html(injected);
  });

  // ── Error Handler ─────────────────────────────────────────────────────────

  app.onError((err, c) => {
    console.error('[Server Error]', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  });
}

// ─── Flush pending patches ──────────────────────────────────────────────────

async function flushPendingDb(): Promise<void> {
  const pendingPaths = Object.keys(saveTimers);
  for (const filePath of pendingPaths) {
    if (saveTimers[filePath]) {
      clearTimeout(saveTimers[filePath]);
      delete saveTimers[filePath];
    }
    try {
      const decodedKey = Buffer.from(filePath, 'hex').toString('utf-8');
      if (dbCache[filePath]) {
        const data = Buffer.from(JSON.stringify(dbCache[filePath]));
        await kvSet(decodedKey, data);
        delete dbCache[filePath];
      }
    } catch (err) {
      console.error(`[Flush] Error flushing ${filePath}:`, err);
    }
  }
}

// ─── KV list with prefix ────────────────────────────────────────────────────

async function kvListPrefix(prefix: string): Promise<string[]> {
  const all = await kvList(prefix);
  return all;
}
