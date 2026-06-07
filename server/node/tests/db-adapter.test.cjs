/**
 * Tests for database adapter (SQLite and PostgreSQL abstraction).
 * 
 * Run: node server/node/tests/db-adapter.test.cjs
 */
const { strictEqual, ok } = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

console.log('Running database adapter tests...');

// ─── Test 1: SQLite adapter creation ─────────────────────────────────────────
async function testSQLiteAdapter() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-adapter-test-'));
    const dbPath = path.join(tmpDir, 'test.db');

    const { createSQLiteAdapter, applySchema } = require('../db-adapter.cjs');
    const adapter = createSQLiteAdapter(dbPath);

    strictEqual(adapter.driver, 'sqlite', 'Driver should be sqlite');
    ok(adapter.db, 'Should have raw db instance');
    ok(adapter.prepare, 'Should have prepare method');
    ok(adapter.exec, 'Should have exec method');
    ok(adapter.transaction, 'Should have transaction method');
    ok(adapter.close, 'Should have close method');

    // Apply schema
    applySchema(adapter);

    // Verify tables exist
    const tables = adapter.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tableNames = tables.map(t => t.name);
    ok(tableNames.includes('kv'), 'kv table should exist');
    ok(tableNames.includes('settings'), 'settings table should exist');
    ok(tableNames.includes('characters'), 'characters table should exist');
    ok(tableNames.includes('chats'), 'chats table should exist');
    ok(tableNames.includes('chat_messages'), 'chat_messages table should exist');

    // Test KV operations
    const insert = adapter.prepare(`INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`);
    insert.run('test_key', Buffer.from('test_value'), Date.now());

    const row = adapter.prepare(`SELECT value FROM kv WHERE key = ?`).get('test_key');
    ok(row, 'Should find test_key');
    strictEqual(row.value.toString(), 'test_value', 'Should have correct value');

    adapter.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('✓ Test 1: SQLite adapter creation passed');
}

// ─── Test 2: Factory function ────────────────────────────────────────────────
async function testFactory() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-factory-test-'));
    const dbPath = path.join(tmpDir, 'test.db');

    const { createDatabaseAdapter } = require('../db-adapter.cjs');

    // Test SQLite via factory
    const sqliteAdapter = createDatabaseAdapter(`sqlite://${dbPath}`);
    strictEqual(sqliteAdapter.driver, 'sqlite', 'Factory should create SQLite adapter');
    sqliteAdapter.close();

    // Test default (no URL)
    process.env.SAVE_DIR = tmpDir;
    const defaultAdapter = createDatabaseAdapter(null);
    strictEqual(defaultAdapter.driver, 'sqlite', 'Factory should default to SQLite');
    defaultAdapter.close();

    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log('✓ Test 2: Factory function passed');
}

// ─── Test 3: SQLite→PostgreSQL migration function (structure test) ───────────
async function testMigrationFunction() {
    const { migrateSQLiteToPostgreSQL } = require('../db-adapter.cjs');
    ok(typeof migrateSQLiteToPostgreSQL === 'function', 'migrateSQLiteToPostgreSQL should be a function');
    ok(migrateSQLiteToPostgreSQL.length === 2, 'Should accept sqlitePath and pgConnectionString');
    console.log('✓ Test 3: Migration function structure passed');
}

// ─── Run all tests ───────────────────────────────────────────────────────────
async function run() {
    try {
        await testSQLiteAdapter();
        await testFactory();
        await testMigrationFunction();
        console.log('\nAll database adapter tests passed! ✓');
    } catch (err) {
        console.error('\nTest failed:', err);
        process.exit(1);
    }
}

run();
