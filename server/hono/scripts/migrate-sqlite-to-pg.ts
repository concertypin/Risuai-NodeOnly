#!/usr/bin/env tsx
/**
 * @fileoverview Migrate data from SQLite to PostgreSQL for PocketRisu Hono server.
 *
 * Reads all tables from a SQLite database and writes them to PostgreSQL,
 * creating tables if they don't exist.
 *
 * Environment variables:
 *   DB_SSL_MODE  — set to "require" to enable SSL for cloud PostgreSQL
 *
 * Usage:
 *   tsx scripts/migrate-sqlite-to-pg.ts <sqlite-path> <postgresql-url>
 *
 * Example:
 *   tsx scripts/migrate-sqlite-to-pg.ts save/risuai.db postgresql://user:pass@localhost:5432/risuai
 */

import Database from 'better-sqlite3';
import postgres from 'postgres';
import { readFileSync, existsSync } from 'node:fs';

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

/** Safely quote a PostgreSQL identifier (table/column name). */
function qi(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

/** Convert Buffer to Uint8Array for BYTEA columns. */
function toPgValue(val: unknown): unknown {
  return val instanceof Buffer ? new Uint8Array(val) : val;
}

/* ─── Main ────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const sqlitePath = process.argv[2];
  const pgUrl = process.argv[3];

  if (!sqlitePath || !pgUrl) {
    console.error('Usage: tsx scripts/migrate-sqlite-to-pg.ts <sqlite-path> <postgresql-url>');
    console.error('');
    console.error('Example:');
    console.error('  tsx scripts/migrate-sqlite-to-pg.ts save/risuai.db postgresql://user:pass@localhost:5432/risuai');
    process.exit(1);
  }

  if (!existsSync(sqlitePath)) {
    console.error(`[Migration] SQLite file not found: ${sqlitePath}`);
    process.exit(1);
  }

  const maskedUrl = pgUrl.replace(/:\/\/[^:]+:[^@]+@/, '://***:***@');
  console.log(`[Migration] SQLite: ${sqlitePath}`);
  console.log(`[Migration] PostgreSQL: ${maskedUrl}\n`);

  // ─── Connect ─────────────────────────────────────────────────────────
  console.log('[Migration] Connecting to SQLite...');
  const sqlite = new Database(sqlitePath, { readonly: true });

  const ssl = process.env.DB_SSL_MODE === 'require' ? { rejectUnauthorized: false } : false;
  console.log(`[Migration] Connecting to PostgreSQL${ssl ? ' (SSL)' : ''}...`);
  const pg = postgres(pgUrl, {
    ssl,
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
  });

  // ─── Apply schema ────────────────────────────────────────────────────
  console.log('[Migration] Ensuring PostgreSQL schema...');
  await pg`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value BYTEA NOT NULL,
      updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    )
  `;
  await pg`
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

  // ─── Get tables from SQLite ──────────────────────────────────────────
  const tables: { name: string }[] = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%'")
    .all() as { name: string }[];

  if (tables.length === 0) {
    console.log('[Migration] No tables found in SQLite database.');
    sqlite.close();
    await pg.end();
    return;
  }

  console.log(`[Migration] Found tables: ${tables.map((t) => t.name).join(', ')}\n`);

  // ─── Migrate each table ──────────────────────────────────────────────
  for (const { name: tableName } of tables) {
    console.log(`[Migration] ${tableName} — reading rows...`);

    const rows = sqlite.prepare(`SELECT * FROM "${tableName}"`).all();
    if (rows.length === 0) {
      console.log(`[Migration] ${tableName} — empty, skipping`);
      continue;
    }

    const row = rows[0] as Record<string, unknown>;
    const columns = Object.keys(row);
    console.log(`[Migration] ${tableName} — ${rows.length} rows, columns: [${columns.join(', ')}]`);

    const BATCH = 250;
    let inserted = 0;

    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH) as Record<string, unknown>[];

      // Build VALUES clause: (col_count × batch_size) placeholders
      const cc = columns.length;
      const placeholders: string[] = [];
      const flatValues: unknown[] = [];
      for (let ri = 0; ri < batch.length; ri++) {
        const rowVals: string[] = [];
        for (let ci = 0; ci < cc; ci++) {
          rowVals.push(`$${ri * cc + ci + 1}`);
          flatValues.push(toPgValue(batch[ri][columns[ci]]));
        }
        placeholders.push(`(${rowVals.join(', ')})`);
      }

      const insertSql = [
        `INSERT INTO ${qi(tableName)} (${columns.map(qi).join(', ')})`,
        `VALUES ${placeholders.join(', ')}`,
        'ON CONFLICT DO NOTHING',
      ].join(' ');

      try {
        await pg.unsafe(insertSql, flatValues);
        inserted += batch.length;
      } catch (err) {
        console.error(`\n[Migration] Batch error at row ${i}: ${err}`);
        // Fall back: row by row for this batch
        for (const row of batch) {
          try {
            const vals = columns.map((c) => toPgValue(row[c]));
            const rowSql = [
              `INSERT INTO ${qi(tableName)} (${columns.map(qi).join(', ')})`,
              `VALUES (${columns.map((_, ci) => `$${ci + 1}`).join(', ')})`,
              'ON CONFLICT DO NOTHING',
            ].join(' ');
            await pg.unsafe(rowSql, vals);
            inserted++;
          } catch (rowErr) {
            const firstCol = columns[0];
            const pk = row[firstCol];
            console.error(`[Migration] Skipping ${tableName} row (${firstCol}=${pk}): ${rowErr}`);
          }
        }
      }

      const pct = ((i + batch.length) / rows.length * 100).toFixed(1);
      process.stdout.write(`\r[Migration] ${tableName} — ${inserted}/${rows.length} (${pct}%)`);
    }

    console.log(`\n[Migration] ${tableName} — done (${inserted} rows inserted)`);
  }

  // ─── Done ────────────────────────────────────────────────────────────
  sqlite.close();
  await pg.end();

  const sizeMB = (readFileSync(sqlitePath).length / 1024 / 1024).toFixed(1);
  console.log(`\n[Migration] Complete! (source: ${sizeMB} MB)`);
  console.log(`[Migration] Next: set DATABASE_URL="${process.argv[3]}" and STORAGE=postgres, then restart`);
}

main().catch((err) => {
  console.error('[Migration] Fatal error:', err);
  process.exit(1);
});
