'use strict';

const path = require('path');
const fs = require('fs');
const { createDatabaseAdapter, applySchema } = require('./db-adapter.cjs');

// DATABASE_URL determines the backend:
//   sqlite://path/to/db.sqlite  → SQLite (better-sqlite3)
//   postgresql://user:pass@host/dbname  → PostgreSQL (pg)
//   (unset) → default SQLite in save directory
const dbUrl = process.env.DATABASE_URL;

const adapter = createDatabaseAdapter(dbUrl);
const db = adapter.db; // SQLite raw db (PostgreSQL uses pool directly)
const isPostgreSQL = adapter.driver === 'postgresql';

// Apply schema (tables, indexes) for both SQLite and PostgreSQL
applySchema(adapter);

// ─── KV table ─────────────────────────────────────────────────────────────────
// SQLite uses BLOB, PostgreSQL uses BYTEA for binary data
const blobType = isPostgreSQL ? 'BYTEA' : 'BLOB';
const nowExpr = isPostgreSQL
    ? `(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`
    : `(CAST(strftime('%s','now') AS INTEGER) * 1000)`;

adapter.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key        TEXT    PRIMARY KEY,
    value      ${blobType}    NOT NULL,
    updated_at BIGINT NOT NULL DEFAULT ${nowExpr}
  )
`);

// ─── Migration: /save/ hex files → kv table ──────────────────────────────────
const savePath = path.join(process.cwd(), 'save');
const migrationMarker = path.join(process.cwd(), 'save', '.migrated_to_sqlite');

function migrateFromSaveDir() {
    if (!fs.existsSync(savePath)) return;
    if (fs.existsSync(migrationMarker)) return;

    const hexRegex = /^[0-9a-fA-F]+$/;
    let files;
    try {
        files = fs.readdirSync(savePath);
    } catch {
        return;
    }

    const hexFiles = files.filter(f => hexRegex.test(f));
    if (hexFiles.length === 0) return;

    console.log(`[DB] Migrating ${hexFiles.length} file(s) from /save/ to SQLite...`);

    const insert = adapter.prepare(
        `INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`
    );
    const now = Date.now();

    if (isPostgreSQL) {
        // PostgreSQL: async migration
        (async () => {
            for (let i = 0; i < hexFiles.length; i++) {
                if (i % 100 === 0 || i === hexFiles.length - 1) {
                    console.log(`[DB] Migrating... ${i + 1}/${hexFiles.length}`);
                }
                const key = Buffer.from(hexFiles[i], 'hex').toString('utf-8');
                const value = fs.readFileSync(path.join(savePath, hexFiles[i]));
                await insert.run(key, value, now);
            }
            fs.writeFileSync(migrationMarker, new Date().toISOString(), 'utf-8');
            console.log(`[DB] Migration complete. ${hexFiles.length} files preserved in /save/.`);
        })();
    } else {
        // SQLite: sync migration
        const run = adapter.transaction(() => {
            for (let i = 0; i < hexFiles.length; i++) {
                if (i % 100 === 0 || i === hexFiles.length - 1) {
                    console.log(`[DB] Migrating... ${i + 1}/${hexFiles.length}`);
                }
                const key = Buffer.from(hexFiles[i], 'hex').toString('utf-8');
                const value = fs.readFileSync(path.join(savePath, hexFiles[i]));
                insert.run(key, value, now);
            }
        });
        run();
        fs.writeFileSync(migrationMarker, new Date().toISOString(), 'utf-8');
        console.log(`[DB] Migration complete. ${hexFiles.length} files preserved in /save/.`);
    }
}

migrateFromSaveDir();

// ─── KV operations ────────────────────────────────────────────────────────────
const stmtKvGet    = adapter.prepare(`SELECT value FROM kv WHERE key = ?`);
const stmtKvSet    = adapter.prepare(`INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`);
const stmtKvDel    = adapter.prepare(`DELETE FROM kv WHERE key = ?`);
const stmtKvList   = adapter.prepare(`SELECT key FROM kv`);
const stmtKvPrefix = adapter.prepare(`SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'`);
const stmtKvPrefixSizes = adapter.prepare(`SELECT key, LENGTH(value) as size FROM kv WHERE key LIKE ? ESCAPE '\\'`);
const stmtKvDelPrefix = adapter.prepare(`DELETE FROM kv WHERE key LIKE ? ESCAPE '\\'`);
const stmtKvSize      = adapter.prepare(`SELECT LENGTH(value) as size FROM kv WHERE key = ?`);
const stmtKvUpdatedAt = adapter.prepare(`SELECT updated_at FROM kv WHERE key = ?`);
const stmtKvCopy = adapter.prepare(
    `INSERT OR REPLACE INTO kv (key, value, updated_at) SELECT ?, value, ? FROM kv WHERE key = ?`
);

function kvGet(key) {
    const row = stmtKvGet.get(key);
    return row ? row.value : null;
}

function kvSet(key, value) {
    stmtKvSet.run(key, value, Date.now());
}

function kvDel(key) {
    stmtKvDel.run(key);
}

function kvSize(key) {
    const row = stmtKvSize.get(key);
    return row ? row.size : null;
}

function kvGetUpdatedAt(key) {
    const row = stmtKvUpdatedAt.get(key);
    return row ? row.updated_at : null;
}

function kvCopyValue(srcKey, dstKey) {
    stmtKvCopy.run(dstKey, Date.now(), srcKey);
}

function kvDelPrefix(prefix) {
    const escaped = prefix.replace(/[\\%_]/g, '\\$&');
    stmtKvDelPrefix.run(`${escaped}%`);
}

function kvList(prefix) {
    if (prefix) {
        const escaped = prefix.replace(/[\\%_]/g, '\\$&');
        return stmtKvPrefix.all(`${escaped}%`).map(r => r.key);
    }
    return stmtKvList.all().map(r => r.key);
}

function kvListWithSizes(prefix) {
    const escaped = prefix.replace(/[\\%_]/g, '\\$&');
    return stmtKvPrefixSizes.all(`${escaped}%`).map(r => ({ key: r.key, size: r.size }));
}

function checkpointWal(mode = 'TRUNCATE') {
    if (isPostgreSQL) return; // PostgreSQL doesn't have WAL checkpoint
    return db.pragma(`wal_checkpoint(${mode})`);
}

function clearEntities() {
    try {
        adapter.exec(`DELETE FROM characters; DELETE FROM chats; DELETE FROM settings; DELETE FROM presets; DELETE FROM modules`);
    } catch {
        // Tables may not exist — ignore
    }
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
    adapter,
    db, // raw SQLite db (null for PostgreSQL)
    isPostgreSQL,
    // KV
    kvGet, kvSet, kvDel, kvList, kvDelPrefix, kvListWithSizes, kvSize, kvGetUpdatedAt, kvCopyValue,
    clearEntities,
    checkpointWal,
};
