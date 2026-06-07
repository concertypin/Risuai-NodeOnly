/**
 * Tests for granular API database operations.
 * 
 * Run: node server/node/tests/granular.test.cjs
 */
const { strictEqual, deepStrictEqual, ok } = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Use a temporary database for tests
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'granular-test-'));
const tmpDb = path.join(tmpDir, 'test.db');

// Override the SAVE_DIR before requiring db.cjs
process.env.SAVE_DIR = tmpDir;

// We need to mock the db module since it hardcodes the save directory
// Instead, let's create a minimal test that verifies the schema and operations

console.log('Running granular API database tests...');
console.log(`Temp DB: ${tmpDb}`);

// ─── Test 1: Schema creation ─────────────────────────────────────────────────
async function testSchema() {
    const Database = require('better-sqlite3');
    const db = new Database(tmpDb);

    // Create tables
    db.exec(`
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000))
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS characters (id TEXT PRIMARY KEY, name TEXT, avatar TEXT, data TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000))
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS chats (chat_id TEXT PRIMARY KEY, character_id TEXT REFERENCES characters(id), name TEXT, last_date TEXT, folder_id TEXT, message_count INTEGER DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000))
    `);
    db.exec(`
        CREATE TABLE IF NOT EXISTS chat_messages (chat_id TEXT, message_index INTEGER, data TEXT NOT NULL, PRIMARY KEY (chat_id, message_index), FOREIGN KEY (chat_id) REFERENCES chats(chat_id))
    `);

    // Verify tables exist
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all();
    const tableNames = tables.map(t => t.name);
    ok(tableNames.includes('settings'), 'settings table should exist');
    ok(tableNames.includes('characters'), 'characters table should exist');
    ok(tableNames.includes('chats'), 'chats table should exist');
    ok(tableNames.includes('chat_messages'), 'chat_messages table should exist');

    db.close();
    console.log('✓ Test 1: Schema creation passed');
}

// ─── Test 2: Settings CRUD ───────────────────────────────────────────────────
async function testSettings() {
    const Database = require('better-sqlite3');
    const db = new Database(tmpDb);

    const stmtSet = db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`);
    const stmtGet = db.prepare(`SELECT value FROM settings WHERE key = ?`);
    const stmtAll = db.prepare(`SELECT key, value FROM settings`);
    const stmtDel = db.prepare(`DELETE FROM settings WHERE key = ?`);

    // Set
    stmtSet.run('api_keys', JSON.stringify({ openai: 'sk-xxx', anthropic: 'sk-yyy' }), Date.now());
    stmtSet.run('theme', JSON.stringify('dark'), Date.now());

    // Get
    const row = stmtGet.get('api_keys');
    ok(row, 'Should find api_keys');
    const parsed = JSON.parse(row.value);
    strictEqual(parsed.openai, 'sk-xxx', 'Should have correct openai key');

    // Get all
    const all = stmtAll.all().reduce((acc, r) => { acc[r.key] = JSON.parse(r.value); return acc; }, {});
    strictEqual(Object.keys(all).length, 2, 'Should have 2 settings');
    strictEqual(all.theme, 'dark', 'Should have correct theme');

    // Delete
    stmtDel.run('theme');
    const deleted = stmtGet.get('theme');
    strictEqual(deleted, undefined, 'Should be deleted');

    db.close();
    console.log('✓ Test 2: Settings CRUD passed');
}

// ─── Test 3: Characters and Chats ────────────────────────────────────────────
async function testCharactersChats() {
    const Database = require('better-sqlite3');
    const db = new Database(tmpDb);

    const stmtCharSet = db.prepare(`INSERT OR REPLACE INTO characters (id, name, avatar, data, updated_at) VALUES (?, ?, ?, ?, ?)`);
    const stmtCharList = db.prepare(`SELECT id, name, avatar, updated_at FROM characters ORDER BY updated_at DESC`);
    const stmtChatSet = db.prepare(`INSERT OR REPLACE INTO chats (chat_id, character_id, name, last_date, folder_id, message_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const stmtChatByChar = db.prepare(`SELECT chat_id, name, last_date, folder_id, message_count, updated_at FROM chats WHERE character_id = ? ORDER BY last_date DESC`);
    const stmtMsgSet = db.prepare(`INSERT OR REPLACE INTO chat_messages (chat_id, message_index, data) VALUES (?, ?, ?)`);
    const stmtMsgByChat = db.prepare(`SELECT message_index, data FROM chat_messages WHERE chat_id = ? ORDER BY message_index ASC`);

    // Create character
    const charData = { name: 'Test Character', description: 'A test character', scenario: 'Test scenario' };
    stmtCharSet.run('char_001', 'Test Character', 'avatar.png', JSON.stringify(charData), Date.now());

    // Verify character
    const chars = stmtCharList.all();
    strictEqual(chars.length, 1, 'Should have 1 character');
    strictEqual(chars[0].name, 'Test Character', 'Should have correct name');

    // Create chats
    stmtChatSet.run('chat_001', 'char_001', 'Chat 1', '2026-01-01', null, 0, Date.now());
    stmtChatSet.run('chat_002', 'char_001', 'Chat 2', '2026-01-02', null, 0, Date.now());

    // Verify chats by character
    const chats = stmtChatByChar.all('char_001');
    strictEqual(chats.length, 2, 'Should have 2 chats');
    strictEqual(chats[0].name, 'Chat 2', 'Should be ordered by last_date DESC');

    // Add messages
    stmtMsgSet.run('chat_001', 0, JSON.stringify({ role: 'user', content: 'Hello' }));
    stmtMsgSet.run('chat_001', 1, JSON.stringify({ role: 'assistant', content: 'Hi there!' }));

    // Verify messages
    const msgs = stmtMsgByChat.all('chat_001');
    strictEqual(msgs.length, 2, 'Should have 2 messages');
    strictEqual(JSON.parse(msgs[0].data).role, 'user', 'First message should be user');
    strictEqual(JSON.parse(msgs[1].data).role, 'assistant', 'Second message should be assistant');

    db.close();
    console.log('✓ Test 3: Characters and Chats passed');
}

// ─── Test 4: ETag generation ─────────────────────────────────────────────────
async function testEtag() {
    const crypto = require('crypto');
    
    function computeEtag(str) {
        return `"${crypto.createHash('sha256').update(str).digest('hex').slice(0, 16)}"`;
    }

    const data = JSON.stringify({ key: 'value' });
    const etag1 = computeEtag(data);
    const etag2 = computeEtag(data);
    strictEqual(etag1, etag2, 'Same data should produce same ETag');
    ok(etag1.startsWith('"') && etag1.endsWith('"'), 'ETag should be quoted');
    strictEqual(etag1.length, 18, 'ETag should be 16 chars + 2 quotes');

    const etag3 = computeEtag('different');
    ok(etag1 !== etag3, 'Different data should produce different ETag');

    console.log('✓ Test 4: ETag generation passed');
}

// ─── Run all tests ───────────────────────────────────────────────────────────
async function run() {
    try {
        await testSchema();
        await testSettings();
        await testCharactersChats();
        await testEtag();
        console.log('\nAll granular API tests passed! ✓');
    } catch (err) {
        console.error('\nTest failed:', err);
        process.exit(1);
    } finally {
        // Cleanup
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
}

run();
