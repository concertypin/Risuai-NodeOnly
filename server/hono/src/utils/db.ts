/**
 * @fileoverview PostgreSQL KV store — drop-in replacement for server/node/db.cjs
 *
 * Uses the `postgres` (porsager/postgres) library for PostgreSQL.
 * In-memory mode is opt-in via STORAGE=memory env var (not a fallback).
 *
 * Storage modes (mutually exclusive, selected at initialization):
 *   postgres — requires DATABASE_URL. Connection error throws at startup.
 *   memory   — explicitly opt-in. No DATABASE_URL needed. Good for dev/test.
 *
 * Environment:
 *   STORAGE      — "memory" or "postgres". Must be explicitly set; no auto-detection.
 *   DATABASE_URL — PostgreSQL connection string. Required when STORAGE is not "memory".
 *
 * Schema (PostgreSQL):
 *   kv (key TEXT PRIMARY KEY, value BYTEA NOT NULL, updated_at BIGINT NOT NULL)
 *   logs (id BIGSERIAL, timestamp BIGINT, level TEXT, origin TEXT, message TEXT, ...)
 *
 * Schema (in-memory):
 *   identical behaviour via Map + array, same function signatures.
 */

import postgres from 'postgres';
import { readFile, writeFile } from 'node:fs/promises';
/**
 * NOTE: Buffer is used throughout for BYTEA compatibility with the postgres library.
 * For serverless (Cloudflare Workers etc.), replace the postgres client with
 * `@neondatabase/serverless` or `d1` and swap Buffer calls for Uint8Array.
 */

// ─── Storage Mode ────────────────────────────────────────────────────────────

const STORAGE_MODE = process.env.STORAGE?.toLowerCase();
if (!STORAGE_MODE) {
  throw new Error('STORAGE environment variable must be explicitly set to "memory" or "postgres".');
}
if (STORAGE_MODE !== 'memory' && STORAGE_MODE !== 'postgres') {
  throw new Error(`Invalid STORAGE="${STORAGE_MODE}". Must be "memory" or "postgres".`);
}
if (STORAGE_MODE === 'postgres' && !process.env.DATABASE_URL) {
  throw new Error('STORAGE=postgres requires DATABASE_URL environment variable.');
}

// ─── Connection ──────────────────────────────────────────────────────────────

let sql: ReturnType<typeof postgres> | null = null;

if (STORAGE_MODE === 'postgres') {
  sql = postgres(process.env.DATABASE_URL!, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 15,
  });
}

// ─── In-Memory Store ─────────────────────────────────────────────────────────

const memStore = new Map<string, Buffer>();
const memTimestamps = new Map<string, number>();
const memLogs: Array<Record<string, unknown>> = [];
let memLogId = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isMemory(): boolean {
  return STORAGE_MODE === 'memory';
}

function getSql(): ReturnType<typeof postgres> {
  if (!sql) throw new Error('[DB] PostgreSQL not initialized (DATABASE_URL not set?)');
  return sql;
}

// ─── Table Setup ─────────────────────────────────────────────────────────────

export async function ensureTables(): Promise<void> {
  if (isMemory()) {
    console.log('[DB] Using in-memory store (opt-in via STORAGE=memory)');
    memStore.clear();
    memTimestamps.clear();
    memLogs.length = 0;
    memLogId = 0;
    return;
  }
  try {
    const s = getSql();
    await s`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value BYTEA NOT NULL,
        updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
      )
    `;
    await s`
      CREATE TABLE IF NOT EXISTS logs (
        id BIGSERIAL PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        level TEXT NOT NULL,
        origin TEXT NOT NULL,
        message TEXT NOT NULL,
        description TEXT,
        source TEXT,
        count INTEGER DEFAULT 1,
        platform TEXT,
        client_id TEXT,
        user_agent TEXT
      )
    `;
    // Verify connection with a simple query
    await s`SELECT 1 AS ok`;
    console.log('[DB] PostgreSQL connection verified, tables ensured');
  } catch (err) {
    console.error('[DB] Failed to create tables:', err);
    throw err;
  }
}

// ─── Backup / File Import ────────────────────────────────────────────────────

export async function importFromJSONL(jsonlPath: string): Promise<number> {
  if (isMemory()) {
    throw new Error('importFromJSONL requires PostgreSQL storage');
  }
  const content = await readFile(jsonlPath, 'utf-8');
  const lines = content.trim().split('\n');
  let count = 0;
  const s = getSql();
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      const key: string = record.key ?? record.id;
      const value: Buffer = record.value
        ? Buffer.from(record.value, record.valueEncoding ?? 'base64')
        : Buffer.from(JSON.stringify(record));
      await s`
        INSERT INTO kv (key, value, updated_at)
        VALUES (${key}, ${value}, ${record.updated_at ?? Date.now()})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
      `;
      count++;
    } catch {
      // skip malformed lines
    }
  }
  return count;
}

export async function exportToJSONL(jsonlPath: string): Promise<number> {
  if (isMemory()) {
    throw new Error('exportToJSONL requires PostgreSQL storage');
  }
  const s = getSql();
  const rows = await s`SELECT key, value, updated_at FROM kv ORDER BY key`;
  const lines = rows.map(r => JSON.stringify({ key: r.key, value: Buffer.from(r.value).toString('base64'), valueEncoding: 'base64', updated_at: Number(r.updated_at) }));
  await writeFile(jsonlPath, lines.join('\n'), 'utf-8');
  return rows.length;
}

// ─── KV Operations ───────────────────────────────────────────────────────────

export async function kvGet(key: string): Promise<Buffer | null> {
  if (isMemory()) {
    return memStore.get(key) ?? null;
  }
  const s = getSql();
  const rows = await s`SELECT value FROM kv WHERE key = ${key}`;
  if (rows.length === 0) return null;
  return Buffer.from(rows[0].value);
}

export async function kvSet(key: string, value: string | Buffer | Uint8Array): Promise<void> {
  const buf = typeof value === 'string' ? Buffer.from(value, 'utf-8') : Buffer.from(value);
  if (isMemory()) {
    memStore.set(key, buf);
    memTimestamps.set(key, Date.now());
    return;
  }
  const s = getSql();
  await s`
    INSERT INTO kv (key, value, updated_at)
    VALUES (${key}, ${buf}, ${Date.now()})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `;
}

export async function kvSetBatch(entries: Array<{ key: string; value: string | Buffer }>): Promise<void> {
  if (isMemory()) {
    for (const { key, value } of entries) {
      const buf = typeof value === 'string' ? Buffer.from(value, 'utf-8') : Buffer.from(value);
      memStore.set(key, buf);
      memTimestamps.set(key, Date.now());
    }
    return;
  }
  const s = getSql();
  for (const { key, value } of entries) {
    const buf = typeof value === 'string' ? Buffer.from(value, 'utf-8') : Buffer.from(value);
    await s`
      INSERT INTO kv (key, value, updated_at)
      VALUES (${key}, ${buf}, ${Date.now()})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `;
  }
}

export async function kvDel(key: string): Promise<boolean> {
  if (isMemory()) {
    const existed = memStore.has(key);
    memStore.delete(key);
    memTimestamps.delete(key);
    return existed;
  }
  const s = getSql();
  const result = await s`DELETE FROM kv WHERE key = ${key}`;
  return result.count > 0;
}

export async function kvSize(key: string): Promise<number | null> {
  if (isMemory()) {
    const val = memStore.get(key);
    return val ? val.length : null;
  }
  const s = getSql();
  const rows = await s`SELECT OCTET_LENGTH(value)::INTEGER as size FROM kv WHERE key = ${key}`;
  return rows.length > 0 ? Number(rows[0].size) : null;
}

export async function kvGetUpdatedAt(key: string): Promise<number | null> {
  if (isMemory()) {
    return memTimestamps.get(key) ?? null;
  }
  const s = getSql();
  const rows = await s`SELECT updated_at FROM kv WHERE key = ${key}`;
  return rows.length > 0 ? Number(rows[0].updated_at) : null;
}

export async function kvCopyValue(srcKey: string, dstKey: string): Promise<void> {
  if (isMemory()) {
    const val = memStore.get(srcKey);
    if (val) {
      memStore.set(dstKey, Buffer.from(val));
      memTimestamps.set(dstKey, Date.now());
    }
    return;
  }
  const s = getSql();
  await s`
    INSERT INTO kv (key, value, updated_at)
    SELECT ${dstKey}, value, ${Date.now()} FROM kv WHERE key = ${srcKey}
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `;
}

export async function kvDelPrefix(prefix: string): Promise<void> {
  if (isMemory()) {
    for (const key of memStore.keys()) {
      if (key.startsWith(prefix)) {
        memStore.delete(key);
        memTimestamps.delete(key);
      }
    }
    return;
  }
  const s = getSql();
  await s`DELETE FROM kv WHERE key LIKE ${prefix + '%'}`;
}

export async function kvList(prefix?: string): Promise<string[]> {
  if (isMemory()) {
    const keys = Array.from(memStore.keys());
    if (prefix) return keys.filter(k => k.startsWith(prefix));
    return keys;
  }
  const s = getSql();
  if (prefix) {
    const rows = await s`SELECT key FROM kv WHERE key LIKE ${prefix + '%'}`;
    return rows.map(r => r.key);
  }
  const rows = await s`SELECT key FROM kv`;
  return rows.map(r => r.key);
}

export async function kvListWithSizes(prefix: string): Promise<{ key: string; size: number }[]> {
  if (isMemory()) {
    const keys = Array.from(memStore.keys()).filter(k => k.startsWith(prefix));
    return keys.map(k => ({ key: k, size: memStore.get(k)?.length ?? 0 }));
  }
  const s = getSql();
  const rows = await s`
    SELECT key, OCTET_LENGTH(value)::INTEGER as size FROM kv WHERE key LIKE ${prefix + '%'}
  `;
  return rows.map(r => ({ key: r.key, size: Number(r.size) }));
}

export async function checkpointWal(_mode?: string): Promise<void> {
  // PostgreSQL doesn't need WAL checkpoint management (automatic)
  // In-memory doesn't either
}

export async function clearEntities(): Promise<void> {
  if (isMemory()) {
    memStore.clear();
    memTimestamps.clear();
    return;
  }
  const s = getSql();
  await s`DELETE FROM kv`;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export async function kvSizeTotal(): Promise<number> {
  if (isMemory()) {
    return Array.from(memStore.values()).reduce((sum, buf) => sum + buf.length, 0);
  }
  const s = getSql();
  const rows = await s`SELECT COALESCE(SUM(OCTET_LENGTH(value)), 0)::BIGINT as total FROM kv`;
  return Number(rows[0]?.total ?? 0);
}

export async function kvCount(): Promise<number> {
  if (isMemory()) return memStore.size;
  const s = getSql();
  const rows = await s`SELECT COUNT(*)::INTEGER as cnt FROM kv`;
  return Number(rows[0]?.cnt ?? 0);
}

export async function kvPrefixCount(prefix: string): Promise<number> {
  if (isMemory()) {
    return Array.from(memStore.keys()).filter(k => k.startsWith(prefix)).length;
  }
  const s = getSql();
  const rows = await s`SELECT COUNT(*)::INTEGER as cnt FROM kv WHERE key LIKE ${prefix + '%'}`;
  return Number(rows[0]?.cnt ?? 0);
}

export async function kvPrefixSize(prefix: string): Promise<number> {
  if (isMemory()) {
    return Array.from(memStore.entries())
      .filter(([k]) => k.startsWith(prefix))
      .reduce((sum, [, buf]) => sum + buf.length, 0);
  }
  const s = getSql();
  const rows = await s`
    SELECT COALESCE(SUM(OCTET_LENGTH(value)), 0)::BIGINT as total FROM kv WHERE key LIKE ${prefix + '%'}
  `;
  return Number(rows[0]?.total ?? 0);
}

// ─── Logging ─────────────────────────────────────────────────────────────────

const LOG_MAX_ROWS = 5000;

export interface LogEntry {
  timestamp: number;
  level: string;
  origin: string;
  message: string;
  description?: string;
  source?: string;
  count?: number;
  platform?: string;
  client_id?: string;
  user_agent?: string;
}

export async function addLogEntry(entry: LogEntry): Promise<void> {
  if (isMemory()) {
    memLogs.push({ ...entry, id: ++memLogId });
    if (memLogs.length > LOG_MAX_ROWS) memLogs.shift();
    return;
  }
  const s = getSql();
  await s`
    INSERT INTO logs (timestamp, level, origin, message, description, source, count, platform, client_id, user_agent)
    VALUES (${entry.timestamp}, ${entry.level}, ${entry.origin}, ${entry.message},
            ${entry.description ?? null}, ${entry.source ?? null}, ${entry.count ?? 1},
            ${entry.platform ?? null}, ${(entry.client_id ?? (entry as any).clientId ?? null)}, ${(entry.user_agent ?? (entry as any).userAgent ?? null)})
  `;
}

export async function addLogBatch(entries: LogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  if (isMemory()) {
    for (const e of entries) {
      memLogs.push({ ...e, id: ++memLogId });
    }
    while (memLogs.length > LOG_MAX_ROWS) memLogs.shift();
    return;
  }
  const s = getSql();
  for (const entry of entries.slice(0, 1000)) {
    await s`
      INSERT INTO logs (timestamp, level, origin, message, description, source, count, platform, client_id, user_agent)
      VALUES (${entry.timestamp}, ${entry.level}, ${entry.origin}, ${entry.message},
              ${entry.description ?? null}, ${entry.source ?? null}, ${entry.count ?? 1},
              ${entry.platform ?? null}, ${entry.client_id ?? null}, ${entry.user_agent ?? null})
    `;
  }
  // Rotate
  await s`
    DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY timestamp DESC LIMIT ${LOG_MAX_ROWS})
  `;
}

export async function queryLogs(params: {
  level?: string;
  origin?: string;
  limit?: number;
  offset?: number;
}): Promise<LogEntry[]> {
  if (isMemory()) {
    let result = memLogs;
    if (params.level) result = result.filter(l => l.level === params.level);
    if (params.origin) result = result.filter(l => l.origin === params.origin);
    const limit = Math.min(params.limit ?? 100, 1000);
    const offset = params.offset ?? 0;
    return result.slice(offset, offset + limit) as unknown as LogEntry[];
  }
  const s = getSql();
  const limit = Math.min(params.limit ?? 100, 1000);
  const offset = params.offset ?? 0;

  // Build WHERE clause using postgres.js fragment composition
  const conditions: ReturnType<typeof s>[] = [];
  if (params.level) conditions.push(s`level = ${params.level}`);
  if (params.origin) conditions.push(s`origin = ${params.origin}`);

  if (conditions.length === 0) {
    const rows = await s`
      SELECT timestamp, level, origin, message, description, source, count, platform, client_id, user_agent
      FROM logs
      ORDER BY timestamp DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map(r => ({
      timestamp: Number(r.timestamp),
      level: r.level,
      origin: r.origin,
      message: r.message,
      description: r.description ?? undefined,
      source: r.source ?? undefined,
      count: Number(r.count),
      platform: r.platform ?? undefined,
      client_id: r.client_id ?? undefined,
      user_agent: r.user_agent ?? undefined,
    }));
  }

  // Single condition — no AND needed
  if (conditions.length === 1) {
    const rows = await s`
      SELECT timestamp, level, origin, message, description, source, count, platform, client_id, user_agent
      FROM logs
      WHERE ${conditions[0]}
      ORDER BY timestamp DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    return rows.map(r => ({
      timestamp: Number(r.timestamp),
      level: r.level,
      origin: r.origin,
      message: r.message,
      description: r.description ?? undefined,
      source: r.source ?? undefined,
      count: Number(r.count),
      platform: r.platform ?? undefined,
      client_id: r.client_id ?? undefined,
      user_agent: r.user_agent ?? undefined,
    }));
  }

  // Multiple conditions — combine with AND
  const rows = await s`
    SELECT timestamp, level, origin, message, description, source, count, platform, client_id, user_agent
    FROM logs
    WHERE ${conditions[0]} AND ${conditions[1]}
    ORDER BY timestamp DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  return rows.map(r => ({
    timestamp: Number(r.timestamp),
    level: r.level,
    origin: r.origin,
    message: r.message,
    description: r.description ?? undefined,
    source: r.source ?? undefined,
    count: Number(r.count),
    platform: r.platform ?? undefined,
    client_id: r.client_id ?? undefined,
    user_agent: r.user_agent ?? undefined,
  }));
}

export async function deleteLogs(beforeTimestamp?: number): Promise<void> {
  if (isMemory()) {
    if (beforeTimestamp) {
      const filtered = memLogs.filter(l => (l.timestamp as number) >= beforeTimestamp);
      memLogs.length = 0;
      memLogs.push(...filtered);
    } else {
      memLogs.length = 0;
    }
    return;
  }
  const s = getSql();
  if (beforeTimestamp) {
    await s`DELETE FROM logs WHERE timestamp < ${beforeTimestamp}`;
  } else {
    await s`DELETE FROM logs`;
  }
}

export async function rotateLogs(): Promise<void> {
  if (isMemory()) {
    while (memLogs.length > LOG_MAX_ROWS) memLogs.shift();
    return;
  }
  const s = getSql();
  await s`
    DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY timestamp DESC LIMIT ${LOG_MAX_ROWS})
  `;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

export function getStorageMode(): string {
  return STORAGE_MODE;
}

export function isUsingMemoryFallback(): boolean {
  console.warn('[DB] isUsingMemoryFallback() is deprecated — use getStorageMode() instead');
  return isMemory();
}
