/**
 * @fileoverview PostgreSQL KV store — drop-in replacement for server/node/db.cjs
 *
 * Uses the `postgres` (porsager/postgres) library for PostgreSQL.
 * Falls back to in-memory Map if DATABASE_URL is not set (for development/testing).
 *
 * Environment:
 *   DATABASE_URL — PostgreSQL connection string (postgresql://...)
 *                  If unset, uses in-memory fallback.
 *
 * Schema:
 *   kv (key TEXT PRIMARY KEY, value BYTEA NOT NULL, updated_at BIGINT NOT NULL)
 *   logs (id BIGSERIAL, timestamp BIGINT, level TEXT, origin TEXT, message TEXT, ...)
 */

import postgres from 'postgres';

// ─── Connection ──────────────────────────────────────────────────────────────

let sql: ReturnType<typeof postgres> | null = null;
let useMemoryFallback = false;

// In-memory fallback for when there's no PostgreSQL
const memStore = new Map<string, Buffer>();
const memTimestamps = new Map<string, number>();
const memLogs: Array<Record<string, unknown>> = [];
let memLogId = 0;

function getSql(): ReturnType<typeof postgres> {
  if (useMemoryFallback) {
    throw new Error('Using in-memory fallback');
  }
  if (!sql) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      console.warn('[DB] No DATABASE_URL set, using in-memory fallback');
      useMemoryFallback = true;
      throw new Error('No DATABASE_URL');
    }
    sql = postgres(dbUrl, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 15,
    });
  }
  return sql;
}

export async function ensureTables(): Promise<void> {
  if (useMemoryFallback) return;
  try {
    const s = getSql();
    await s`
      CREATE TABLE IF NOT EXISTS kv (
        key        TEXT    PRIMARY KEY,
        value      BYTEA   NOT NULL,
        updated_at BIGINT  NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
      )
    `;
    await s`
      CREATE TABLE IF NOT EXISTS logs (
        id          BIGSERIAL PRIMARY KEY,
        timestamp   BIGINT       NOT NULL,
        level       TEXT         NOT NULL,
        origin      TEXT         NOT NULL,
        message     TEXT         NOT NULL,
        description TEXT,
        source      TEXT,
        count       INTEGER      NOT NULL DEFAULT 1,
        platform    TEXT,
        client_id   TEXT,
        user_agent  TEXT
      )
    `;
    await s`
      CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs (timestamp DESC)
    `;
    await s`
      CREATE INDEX IF NOT EXISTS idx_logs_level ON logs (level)
    `;
  } catch (err) {
    console.warn('[DB] PostgreSQL unavailable, falling back to in-memory:', (err as Error).message);
    useMemoryFallback = true;
  }
}

// ─── KV Operations ──────────────────────────────────────────────────────────

export async function kvGet(key: string): Promise<Buffer | null> {
  if (useMemoryFallback) {
    return memStore.get(key) ?? null;
  }
  try {
    const s = getSql();
    const rows = await s`SELECT value FROM kv WHERE key = ${key}`;
    if (rows.length === 0) return null;
    return Buffer.from(rows[0].value);
  } catch {
    useMemoryFallback = true;
    return memStore.get(key) ?? null;
  }
}

export async function kvSet(key: string, value: Buffer | string): Promise<void> {
  const buf = typeof value === 'string' ? Buffer.from(value) : value;
  if (useMemoryFallback) {
    memStore.set(key, buf);
    memTimestamps.set(key, Date.now());
    return;
  }
  try {
    const s = getSql();
    await s`
      INSERT INTO kv (key, value, updated_at)
      VALUES (${key}, ${buf}, ${Date.now()})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `;
  } catch {
    useMemoryFallback = true;
    memStore.set(key, buf);
    memTimestamps.set(key, Date.now());
  }
}

export async function kvDel(key: string): Promise<void> {
  if (useMemoryFallback) {
    memStore.delete(key);
    memTimestamps.delete(key);
    return;
  }
  try {
    const s = getSql();
    await s`DELETE FROM kv WHERE key = ${key}`;
  } catch {
    useMemoryFallback = true;
    memStore.delete(key);
    memTimestamps.delete(key);
  }
}

export async function kvSize(key: string): Promise<number | null> {
  if (useMemoryFallback) {
    const val = memStore.get(key);
    return val ? val.length : null;
  }
  try {
    const s = getSql();
    const rows = await s`SELECT OCTET_LENGTH(value)::INTEGER as size FROM kv WHERE key = ${key}`;
    return rows.length > 0 ? Number(rows[0].size) : null;
  } catch {
    return null;
  }
}

export async function kvGetUpdatedAt(key: string): Promise<number | null> {
  if (useMemoryFallback) {
    return memTimestamps.get(key) ?? null;
  }
  try {
    const s = getSql();
    const rows = await s`SELECT updated_at FROM kv WHERE key = ${key}`;
    return rows.length > 0 ? Number(rows[0].updated_at) : null;
  } catch {
    return null;
  }
}

export async function kvCopyValue(srcKey: string, dstKey: string): Promise<void> {
  if (useMemoryFallback) {
    const val = memStore.get(srcKey);
    if (val) {
      memStore.set(dstKey, val);
      memTimestamps.set(dstKey, Date.now());
    }
    return;
  }
  try {
    const s = getSql();
    await s`
      INSERT INTO kv (key, value, updated_at)
      SELECT ${dstKey}, value, ${Date.now()} FROM kv WHERE key = ${srcKey}
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `;
  } catch {
    useMemoryFallback = true;
    const val = memStore.get(srcKey);
    if (val) {
      memStore.set(dstKey, val);
      memTimestamps.set(dstKey, Date.now());
    }
  }
}

export async function kvDelPrefix(prefix: string): Promise<void> {
  if (useMemoryFallback) {
    for (const key of memStore.keys()) {
      if (key.startsWith(prefix)) {
        memStore.delete(key);
        memTimestamps.delete(key);
      }
    }
    return;
  }
  try {
    const s = getSql();
    await s`DELETE FROM kv WHERE key LIKE ${prefix + '%'}`;
  } catch {
    useMemoryFallback = true;
    for (const key of memStore.keys()) {
      if (key.startsWith(prefix)) {
        memStore.delete(key);
        memTimestamps.delete(key);
      }
    }
  }
}

export async function kvList(prefix?: string): Promise<string[]> {
  if (useMemoryFallback) {
    const keys = Array.from(memStore.keys());
    if (prefix) return keys.filter(k => k.startsWith(prefix!));
    return keys;
  }
  try {
    const s = getSql();
    if (prefix) {
      const rows = await s`SELECT key FROM kv WHERE key LIKE ${prefix + '%'}`;
      return rows.map(r => r.key);
    }
    const rows = await s`SELECT key FROM kv`;
    return rows.map(r => r.key);
  } catch {
    useMemoryFallback = true;
    const keys = Array.from(memStore.keys());
    if (prefix) return keys.filter(k => k.startsWith(prefix!));
    return keys;
  }
}

export async function kvListWithSizes(prefix: string): Promise<{ key: string; size: number }[]> {
  if (useMemoryFallback) {
    const keys = Array.from(memStore.keys()).filter(k => k.startsWith(prefix));
    return keys.map(k => ({ key: k, size: memStore.get(k)?.length ?? 0 }));
  }
  try {
    const s = getSql();
    const rows = await s`
      SELECT key, OCTET_LENGTH(value)::INTEGER as size FROM kv WHERE key LIKE ${prefix + '%'}
    `;
    return rows.map(r => ({ key: r.key, size: Number(r.size) }));
  } catch {
    return [];
  }
}

export async function checkpointWal(_mode?: string): Promise<void> {
  // PostgreSQL doesn't need WAL checkpoint management
}

export async function clearEntities(): Promise<void> {
  if (useMemoryFallback) {
    memStore.clear();
    memTimestamps.clear();
    return;
  }
  try {
    const s = getSql();
    await s`DELETE FROM kv`;
  } catch {
    useMemoryFallback = true;
    memStore.clear();
    memTimestamps.clear();
  }
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export async function kvSizeTotal(): Promise<number> {
  if (useMemoryFallback) {
    return Array.from(memStore.values()).reduce((sum, buf) => sum + buf.length, 0);
  }
  try {
    const s = getSql();
    const rows = await s`SELECT COALESCE(SUM(OCTET_LENGTH(value)), 0)::BIGINT as total FROM kv`;
    return Number(rows[0]?.total ?? 0);
  } catch {
    return 0;
  }
}

export async function kvCount(): Promise<number> {
  if (useMemoryFallback) return memStore.size;
  try {
    const s = getSql();
    const rows = await s`SELECT COUNT(*)::INTEGER as cnt FROM kv`;
    return Number(rows[0]?.cnt ?? 0);
  } catch {
    return memStore.size;
  }
}

export async function kvPrefixCount(prefix: string): Promise<number> {
  if (useMemoryFallback) {
    return Array.from(memStore.keys()).filter(k => k.startsWith(prefix)).length;
  }
  try {
    const s = getSql();
    const rows = await s`SELECT COUNT(*)::INTEGER as cnt FROM kv WHERE key LIKE ${prefix + '%'}`;
    return Number(rows[0]?.cnt ?? 0);
  } catch {
    return 0;
  }
}

export async function kvPrefixSize(prefix: string): Promise<number> {
  if (useMemoryFallback) {
    return Array.from(memStore.entries())
      .filter(([k]) => k.startsWith(prefix))
      .reduce((sum, [, buf]) => sum + buf.length, 0);
  }
  try {
    const s = getSql();
    const rows = await s`
      SELECT COALESCE(SUM(OCTET_LENGTH(value)), 0)::BIGINT as total FROM kv WHERE key LIKE ${prefix + '%'}
    `;
    return Number(rows[0]?.total ?? 0);
  } catch {
    return 0;
  }
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
  if (useMemoryFallback) {
    memLogs.push({ ...entry, id: ++memLogId });
    if (memLogs.length > LOG_MAX_ROWS) memLogs.shift();
    return;
  }
  try {
    const s = getSql();
    await s`
      INSERT INTO logs (timestamp, level, origin, message, description, source, count, platform, client_id, user_agent)
      VALUES (${entry.timestamp}, ${entry.level}, ${entry.origin}, ${entry.message},
              ${entry.description ?? null}, ${entry.source ?? null}, ${entry.count ?? 1},
              ${entry.platform ?? null}, ${entry.client_id ?? null}, ${entry.user_agent ?? null})
    `;
  } catch {
    // Silently fall back
  }
}

export async function addLogBatch(entries: LogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  if (useMemoryFallback) {
    for (const e of entries) {
      memLogs.push({ ...e, id: ++memLogId });
    }
    while (memLogs.length > LOG_MAX_ROWS) memLogs.shift();
    return;
  }
  try {
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
  } catch {
    // Silently fall back
  }
}

export async function queryLogs(params: {
  level?: string;
  origin?: string;
  limit?: number;
  offset?: number;
}): Promise<LogEntry[]> {
  if (useMemoryFallback) {
    let result = memLogs;
    if (params.level) result = result.filter(l => l.level === params.level);
    if (params.origin) result = result.filter(l => l.origin === params.origin);
    const limit = Math.min(params.limit ?? 100, 1000);
    const offset = params.offset ?? 0;
      return result.slice(offset, offset + limit) as unknown as LogEntry[];
  }
  try {
    const s = getSql();
    const limit = Math.min(params.limit ?? 100, 1000);
    const offset = params.offset ?? 0;
    const conditions = [];
    if (params.level) conditions.push(s`level = ${params.level}`);
    if (params.origin) conditions.push(s`origin = ${params.origin}`);

    const rows = await s`
      SELECT timestamp, level, origin, message, description, source, count, platform, client_id, user_agent
      FROM logs
      ${conditions.length > 0 ? s`WHERE ${conditions[0]}` : s``}
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
  } catch {
    return [];
  }
}

export async function deleteLogs(beforeTimestamp?: number): Promise<void> {
  if (useMemoryFallback) {
    if (beforeTimestamp) {
      const filtered = memLogs.filter(l => (l.timestamp as number) >= beforeTimestamp);
      memLogs.length = 0;
      memLogs.push(...filtered);
    } else {
      memLogs.length = 0;
    }
    return;
  }
  try {
    const s = getSql();
    if (beforeTimestamp) {
      await s`DELETE FROM logs WHERE timestamp < ${beforeTimestamp}`;
    } else {
      await s`DELETE FROM logs`;
    }
  } catch {
    // ignore
  }
}

export async function rotateLogs(): Promise<void> {
  if (useMemoryFallback) {
    while (memLogs.length > LOG_MAX_ROWS) memLogs.shift();
    return;
  }
  try {
    const s = getSql();
    await s`
      DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY timestamp DESC LIMIT ${LOG_MAX_ROWS})
    `;
  } catch {
    // ignore
  }
}

export function isUsingMemoryFallback(): boolean {
  return useMemoryFallback;
}
