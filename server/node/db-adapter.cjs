/**
 * Database abstraction layer for PocketRisu.
 * 
 * Supports both SQLite (better-sqlite3) and PostgreSQL (pg) backends.
 * Selected via DATABASE_URL environment variable:
 *   - sqlite://path/to/db.sqlite  → SQLite
 *   - postgresql://user:pass@host/dbname  → PostgreSQL
 * 
 * All adapters implement the same interface so server.cjs is backend-agnostic.
 */

const path = require('path');
const fs = require('fs');

// ─── Interface definition ─────────────────────────────────────────────────────
// Each adapter must implement:
//   .prepare(sql) → { get(...), all(...), run(...), ... }
//   .exec(sql)
//   .transaction(fn) → result
//   .close()
//   .driver → 'sqlite' | 'postgresql'

// ─── SQLite Adapter ───────────────────────────────────────────────────────────
function createSQLiteAdapter(dbPath) {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, {
        // WAL mode for better concurrent read performance
        nativeBinding: undefined,
    });
    
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000'); // 64MB cache
    db.pragma('foreign_keys = ON');

    return {
        driver: 'sqlite',
        db, // raw db instance for direct access
        
        prepare(sql) {
            return db.prepare(sql);
        },
        
        exec(sql) {
            return db.exec(sql);
        },
        
        transaction(fn) {
            return db.transaction(fn)();
        },
        
        close() {
            db.close();
        },
        
        // SQLite-specific utilities
        pragma(query) {
            return db.pragma(query);
        },
    };
}

// ─── PostgreSQL Adapter ───────────────────────────────────────────────────────
function createPostgreSQLAdapter(connectionString) {
    const { Pool } = require('pg');
    const pool = new Pool({
        connectionString,
        ssl: process.env.DB_SSL_MODE === 'require' ? { rejectUnauthorized: false } : false,
        max: parseInt(process.env.DB_POOL_SIZE || '20'),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    });

    // Wrapper to make pg behave like better-sqlite3's prepared statements
    function prepare(sql) {
        return {
            async get(...params) {
                const result = await pool.query(sql, params);
                return result.rows[0] || undefined;
            },
            async all(...params) {
                const result = await pool.query(sql, params);
                return result.rows;
            },
            async run(...params) {
                const result = await pool.query(sql, params);
                return {
                    changes: result.rowCount,
                    lastInsertRowid: result.rows?.[0]?.id || null,
                };
            },
        };
    }

    return {
        driver: 'postgresql',
        pool, // raw pool for direct access
        
        prepare,
        
        async exec(sql) {
            await pool.query(sql);
        },
        
        async transaction(fn) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const result = await fn(client);
                await client.query('COMMIT');
                return result;
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }
        },
        
        async close() {
            await pool.end();
        },
    };
}

// ─── Factory ──────────────────────────────────────────────────────────────────
function createDatabaseAdapter(dbUrl) {
    if (!dbUrl) {
        // Default: SQLite in save directory
        const saveDir = process.env.SAVE_DIR || path.join(process.cwd(), 'save');
        const dbPath = path.join(saveDir, 'risuai.db');
        fs.mkdirSync(saveDir, { recursive: true });
        return createSQLiteAdapter(dbPath);
    }

    if (dbUrl.startsWith('sqlite://')) {
        const dbPath = dbUrl.replace('sqlite://', '');
        return createSQLiteAdapter(dbPath);
    }

    if (dbUrl.startsWith('postgresql://') || dbUrl.startsWith('postgres://')) {
        return createPostgreSQLAdapter(dbUrl);
    }

    throw new Error(`Unsupported DATABASE_URL: ${dbUrl}. Use sqlite://path or postgresql://host/dbname`);
}

// ─── Schema migrations ────────────────────────────────────────────────────────
function applySchema(adapter) {
    const isPg = adapter.driver === 'postgresql';
    const blobType = isPg ? 'BYTEA' : 'BLOB';
    const nowExpr = isPg
        ? `(EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`
        : `(CAST(strftime('%s','now') AS INTEGER) * 1000)`;
    const bigIntType = isPg ? 'BIGINT' : 'INTEGER';

    const statements = [
        // KV table (legacy compatibility)
        `CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value ${blobType}, updated_at ${bigIntType} DEFAULT ${nowExpr})`,

        // Granular API tables
        `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at ${bigIntType} DEFAULT ${nowExpr})`,
        `CREATE TABLE IF NOT EXISTS presets (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at ${bigIntType} DEFAULT ${nowExpr})`,
        `CREATE TABLE IF NOT EXISTS modules (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at ${bigIntType} DEFAULT ${nowExpr})`,
        `CREATE TABLE IF NOT EXISTS loadouts (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at ${bigIntType} DEFAULT ${nowExpr})`,
        `CREATE TABLE IF NOT EXISTS characters (id TEXT PRIMARY KEY, name TEXT, avatar TEXT, data TEXT NOT NULL, updated_at ${bigIntType} DEFAULT ${nowExpr})`,
        `CREATE TABLE IF NOT EXISTS chats (chat_id TEXT PRIMARY KEY, character_id TEXT REFERENCES characters(id), name TEXT, last_date TEXT, folder_id TEXT, message_count INTEGER DEFAULT 0, updated_at ${bigIntType} DEFAULT ${nowExpr})`,
        `CREATE TABLE IF NOT EXISTS chat_messages (chat_id TEXT, message_index INTEGER, data TEXT NOT NULL, PRIMARY KEY (chat_id, message_index), FOREIGN KEY (chat_id) REFERENCES chats(chat_id))`,
        `CREATE TABLE IF NOT EXISTS plugins (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at ${bigIntType} DEFAULT ${nowExpr})`,
        `CREATE TABLE IF NOT EXISTS plugin_storage (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at ${bigIntType} DEFAULT ${nowExpr})`,
        `CREATE TABLE IF NOT EXISTS migration_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,

        // Indexes for common queries
        `CREATE INDEX IF NOT EXISTS idx_chats_character ON chats(character_id)`,
        `CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages(chat_id)`,
    ];

    for (const stmt of statements) {
        adapter.exec(stmt);
    }
}

// ─── SQLite→PostgreSQL migration ─────────────────────────────────────────────
async function migrateSQLiteToPostgreSQL(sqlitePath, pgConnectionString) {
    console.log('[Migration] Starting SQLite → PostgreSQL migration...');
    
    const sqlite = createSQLiteAdapter(sqlitePath);
    const pg = createPostgreSQLAdapter(pgConnectionString);
    
    // Apply schema to PostgreSQL
    applySchema(pg);
    
    // Migrate all tables
    const tables = sqlite.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    
    for (const { name: tableName } of tables) {
        console.log(`[Migration] Migrating table: ${tableName}`);
        const rows = sqlite.db.prepare(`SELECT * FROM ${tableName}`).all();
        
        if (rows.length === 0) continue;
        
        const columns = Object.keys(rows[0]);
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
        const insertSql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
        
        const insertStmt = pg.prepare(insertSql);
        
        for (const row of rows) {
            const values = columns.map(col => {
                const val = row[col];
                // Convert Buffer to string for BYTEA columns
                if (val instanceof Buffer) return val;
                return val;
            });
            await insertStmt.run(...values);
        }
        
        console.log(`[Migration] Migrated ${rows.length} rows from ${tableName}`);
    }
    
    sqlite.close();
    await pg.close();
    console.log('[Migration] Complete!');
}

module.exports = {
    createDatabaseAdapter,
    createSQLiteAdapter,
    createPostgreSQLAdapter,
    applySchema,
    migrateSQLiteToPostgreSQL,
};
