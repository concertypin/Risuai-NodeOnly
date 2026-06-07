'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const saveDir = path.join(process.cwd(), 'save');
if (!fs.existsSync(saveDir)) {
    fs.mkdirSync(saveDir, { recursive: true });
}
const dbPath = path.join(saveDir, 'risuai.db');
const db = new Database(dbPath);

// WAL mode: better concurrent read performance, single-writer
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000');       // 64 MB (default 2 MB) — reduce disk I/O for large blobs
db.pragma('temp_store = MEMORY');       // keep temp tables in RAM
db.pragma('busy_timeout = 5000');       // wait up to 5 s on lock contention
db.pragma('mmap_size = 268435456');     // 256 MB memory-mapped I/O for faster reads
// Cap WAL file size after a reset checkpoint. Without this, a one-time spike
// (backup import, VACUUM, large asset upload) leaves the -wal file permanently
// at its peak size since RESTART/TRUNCATE rewind the writer but never shrink
// the file unless this limit is set.
db.pragma('journal_size_limit = 268435456');  // 256 MB

// ─── KV table (replaces /save/ hex files) ────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key        TEXT    PRIMARY KEY,
    value      BLOB    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
  )
`);

// Entity tables (characters, chats, settings, presets, modules) were used in
// a previous version. The tables are no longer created or used, but existing
// databases may still contain them. They are left in place (orphaned) to avoid
// destructive DDL on upgrade. clearEntities() handles cleanup during import.

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

    const insert = db.prepare(
        `INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`
    );
    const now = Date.now();

    const run = db.transaction(() => {
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
    console.log(`[DB] To free disk space, remove migrated files via Settings > Clean Up Save Folder.`);
}

migrateFromSaveDir();

// ─── KV operations ────────────────────────────────────────────────────────────
const stmtKvGet    = db.prepare(`SELECT value FROM kv WHERE key = ?`);
const stmtKvSet    = db.prepare(`INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)`);
const stmtKvDel    = db.prepare(`DELETE FROM kv WHERE key = ?`);
const stmtKvList   = db.prepare(`SELECT key FROM kv`);
const stmtKvPrefix = db.prepare(`SELECT key FROM kv WHERE key LIKE ? ESCAPE '\\'`);
const stmtKvPrefixSizes = db.prepare(`SELECT key, LENGTH(value) as size FROM kv WHERE key LIKE ? ESCAPE '\\'`);
const stmtKvDelPrefix = db.prepare(`DELETE FROM kv WHERE key LIKE ? ESCAPE '\\'`);
const stmtKvSize      = db.prepare(`SELECT LENGTH(value) as size FROM kv WHERE key = ?`);
const stmtKvUpdatedAt = db.prepare(`SELECT updated_at FROM kv WHERE key = ?`);
const stmtKvCopy = db.prepare(
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
    return db.pragma(`wal_checkpoint(${mode})`);
}

function clearEntities() {
    // Entity tables may still exist from previous versions — clear them during backup import
    try {
        db.exec(`DELETE FROM characters; DELETE FROM chats; DELETE FROM settings; DELETE FROM presets; DELETE FROM modules`);
    } catch {
        // Tables may not exist — ignore
    }
}

// ─── Granular API tables ─────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS presets (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS modules (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS loadouts (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS characters (
    id         TEXT PRIMARY KEY,
    name       TEXT,
    avatar     TEXT,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    chat_id      TEXT PRIMARY KEY,
    character_id TEXT REFERENCES characters(id),
    name         TEXT,
    last_date    TEXT,
    folder_id    TEXT,
    message_count INTEGER DEFAULT 0,
    updated_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    chat_id       TEXT,
    message_index INTEGER,
    data          TEXT NOT NULL,
    PRIMARY KEY (chat_id, message_index),
    FOREIGN KEY (chat_id) REFERENCES chats(chat_id)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS plugins (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS plugin_storage (
    id         TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS migration_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL
  )
`);

// ─── Granular API prepared statements ─────────────────────────────────────────
// Settings
const stmtSettingsGet = db.prepare(`SELECT key, value FROM settings`);
const stmtSettingsGetByKey = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const stmtSettingsSet = db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)`);
const stmtSettingsDelete = db.prepare(`DELETE FROM settings WHERE key = ?`);

// Presets
const stmtPresetsList = db.prepare(`SELECT id, data FROM presets ORDER BY updated_at DESC`);
const stmtPresetsGet = db.prepare(`SELECT data FROM presets WHERE id = ?`);
const stmtPresetsSet = db.prepare(`INSERT OR REPLACE INTO presets (id, data, updated_at) VALUES (?, ?, ?)`);
const stmtPresetsDelete = db.prepare(`DELETE FROM presets WHERE id = ?`);

// Modules
const stmtModulesList = db.prepare(`SELECT id, data FROM modules ORDER BY updated_at DESC`);
const stmtModulesGet = db.prepare(`SELECT data FROM modules WHERE id = ?`);
const stmtModulesSet = db.prepare(`INSERT OR REPLACE INTO modules (id, data, updated_at) VALUES (?, ?, ?)`);
const stmtModulesDelete = db.prepare(`DELETE FROM modules WHERE id = ?`);

// Loadouts
const stmtLoadoutsList = db.prepare(`SELECT id, data FROM loadouts ORDER BY updated_at DESC`);
const stmtLoadoutsGet = db.prepare(`SELECT data FROM loadouts WHERE id = ?`);
const stmtLoadoutsSet = db.prepare(`INSERT OR REPLACE INTO loadouts (id, data, updated_at) VALUES (?, ?, ?)`);
const stmtLoadoutsDelete = db.prepare(`DELETE FROM loadouts WHERE id = ?`);

// Characters
const stmtCharactersList = db.prepare(`SELECT id, name, avatar, updated_at FROM characters ORDER BY updated_at DESC`);
const stmtCharactersGet = db.prepare(`SELECT id, name, avatar, data, updated_at FROM characters WHERE id = ?`);
const stmtCharactersSet = db.prepare(`INSERT OR REPLACE INTO characters (id, name, avatar, data, updated_at) VALUES (?, ?, ?, ?, ?)`);
const stmtCharactersDelete = db.prepare(`DELETE FROM characters WHERE id = ?`);

// Chats
const stmtChatsByCharacter = db.prepare(`SELECT chat_id, name, last_date, folder_id, message_count, updated_at FROM chats WHERE character_id = ? ORDER BY last_date DESC`);
const stmtChatsGet = db.prepare(`SELECT chat_id, character_id, name, last_date, folder_id, message_count, updated_at FROM chats WHERE chat_id = ?`);
const stmtChatsSet = db.prepare(`INSERT OR REPLACE INTO chats (chat_id, character_id, name, last_date, folder_id, message_count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
const stmtChatsDelete = db.prepare(`DELETE FROM chats WHERE chat_id = ?`);
const stmtChatsDeleteByCharacter = db.prepare(`DELETE FROM chats WHERE character_id = ?`);

// Chat messages
const stmtMessagesByChat = db.prepare(`SELECT message_index, data FROM chat_messages WHERE chat_id = ? ORDER BY message_index ASC LIMIT ? OFFSET ?`);
const stmtMessagesCount = db.prepare(`SELECT COUNT(*) as count FROM chat_messages WHERE chat_id = ?`);
const stmtMessagesGet = db.prepare(`SELECT data FROM chat_messages WHERE chat_id = ? AND message_index = ?`);
const stmtMessagesSet = db.prepare(`INSERT OR REPLACE INTO chat_messages (chat_id, message_index, data) VALUES (?, ?, ?)`);
const stmtMessagesDelete = db.prepare(`DELETE FROM chat_messages WHERE chat_id = ? AND message_index = ?`);
const stmtMessagesDeleteByChat = db.prepare(`DELETE FROM chat_messages WHERE chat_id = ?`);

// Plugins
const stmtPluginsList = db.prepare(`SELECT id, data FROM plugins ORDER BY updated_at DESC`);
const stmtPluginsGet = db.prepare(`SELECT data FROM plugins WHERE id = ?`);
const stmtPluginsSet = db.prepare(`INSERT OR REPLACE INTO plugins (id, data, updated_at) VALUES (?, ?, ?)`);
const stmtPluginsDelete = db.prepare(`DELETE FROM plugins WHERE id = ?`);

// Plugin storage
const stmtPluginStorageList = db.prepare(`SELECT id, data FROM plugin_storage ORDER BY updated_at DESC`);
const stmtPluginStorageGet = db.prepare(`SELECT data FROM plugin_storage WHERE id = ?`);
const stmtPluginStorageSet = db.prepare(`INSERT OR REPLACE INTO plugin_storage (id, data, updated_at) VALUES (?, ?, ?)`);
const stmtPluginStorageDelete = db.prepare(`DELETE FROM plugin_storage WHERE id = ?`);

// Migration state
const stmtMigrationStateGet = db.prepare(`SELECT value FROM migration_state WHERE key = ?`);
const stmtMigrationStateSet = db.prepare(`INSERT OR REPLACE INTO migration_state (key, value) VALUES (?, ?)`);

// ─── Granular API helper functions ────────────────────────────────────────────
function settingsGetAll() {
    return stmtSettingsGet.all().reduce((acc, row) => {
        acc[row.key] = JSON.parse(row.value);
        return acc;
    }, {});
}
function settingsGet(key) {
    const row = stmtSettingsGetByKey.get(key);
    return row ? JSON.parse(row.value) : undefined;
}
function settingsSet(key, value) {
    stmtSettingsSet.run(key, JSON.stringify(value), Date.now());
}
function settingsDelete(key) {
    stmtSettingsDelete.run(key);
}

function presetsList() {
    return stmtPresetsList.all().map(row => JSON.parse(row.data));
}
function presetsGet(id) {
    const row = stmtPresetsGet.get(id);
    return row ? JSON.parse(row.data) : undefined;
}
function presetsSet(id, data) {
    stmtPresetsSet.run(id, JSON.stringify(data), Date.now());
}
function presetsDelete(id) {
    stmtPresetsDelete.run(id);
}

function modulesList() {
    return stmtModulesList.all().map(row => JSON.parse(row.data));
}
function modulesGet(id) {
    const row = stmtModulesGet.get(id);
    return row ? JSON.parse(row.data) : undefined;
}
function modulesSet(id, data) {
    stmtModulesSet.run(id, JSON.stringify(data), Date.now());
}
function modulesDelete(id) {
    stmtModulesDelete.run(id);
}

function loadoutsList() {
    return stmtLoadoutsList.all().map(row => JSON.parse(row.data));
}
function loadoutsGet(id) {
    const row = stmtLoadoutsGet.get(id);
    return row ? JSON.parse(row.data) : undefined;
}
function loadoutsSet(id, data) {
    stmtLoadoutsSet.run(id, JSON.stringify(data), Date.now());
}
function loadoutsDelete(id) {
    stmtLoadoutsDelete.run(id);
}

function charactersList() {
    return stmtCharactersList.all().map(row => ({
        id: row.id,
        name: row.name,
        avatar: row.avatar,
        updated_at: row.updated_at,
    }));
}
function charactersGet(id) {
    const row = stmtCharactersGet.get(id);
    return row ? { id: row.id, name: row.name, avatar: row.avatar, data: JSON.parse(row.data), updated_at: row.updated_at } : undefined;
}
function charactersSet(id, data, name, avatar) {
    stmtCharactersSet.run(id, name || null, avatar || null, JSON.stringify(data), Date.now());
}
function charactersDelete(id) {
    // Delete chats first (cascade)
    const chats = stmtChatsByCharacter.all(id);
    for (const chat of chats) {
        stmtMessagesDeleteByChat.run(chat.chat_id);
    }
    stmtChatsDeleteByCharacter.run(id);
    stmtCharactersDelete.run(id);
}

function chatsByCharacter(characterId) {
    return stmtChatsByCharacter.all(characterId);
}
function chatsGet(chatId) {
    return stmtChatsGet.get(chatId);
}
function chatsSet(chatId, characterId, name, lastDate, folderId, messageCount) {
    stmtChatsSet.run(chatId, characterId, name || null, lastDate || null, folderId || null, messageCount || 0, Date.now());
}
function chatsDelete(chatId) {
    stmtMessagesDeleteByChat.run(chatId);
    stmtChatsDelete.run(chatId);
}

function messagesByChat(chatId, limit, offset) {
    return stmtMessagesByChat.all(chatId, limit, offset).map(row => JSON.parse(row.data));
}
function messagesCount(chatId) {
    const row = stmtMessagesCount.get(chatId);
    return row ? row.count : 0;
}
function messagesGet(chatId, index) {
    const row = stmtMessagesGet.get(chatId, index);
    return row ? JSON.parse(row.data) : undefined;
}
function messagesSet(chatId, index, data) {
    stmtMessagesSet.run(chatId, index, JSON.stringify(data));
    // Update message_count
    const count = messagesCount(chatId);
    const chat = chatsGet(chatId);
    if (chat) {
        stmtChatsSet.run(chatId, chat.character_id, chat.name, chat.last_date, chat.folder_id, count, Date.now());
    }
}
function messagesDelete(chatId, index) {
    stmtMessagesDelete.run(chatId, index);
    const count = messagesCount(chatId);
    const chat = chatsGet(chatId);
    if (chat) {
        stmtChatsSet.run(chatId, chat.character_id, chat.name, chat.last_date, chat.folder_id, count, Date.now());
    }
}

function migrationStateGet(key) {
    const row = stmtMigrationStateGet.get(key);
    return row ? row.value : undefined;
}
function migrationStateSet(key, value) {
    stmtMigrationStateSet.run(key, value);
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
    db,
    // KV
    kvGet, kvSet, kvDel, kvList, kvDelPrefix, kvListWithSizes, kvSize, kvGetUpdatedAt, kvCopyValue,
    clearEntities,
    checkpointWal,
    // Granular API
    settingsGetAll, settingsGet, settingsSet, settingsDelete,
    presetsList, presetsGet, presetsSet, presetsDelete,
    modulesList, modulesGet, modulesSet, modulesDelete,
    loadoutsList, loadoutsGet, loadoutsSet, loadoutsDelete,
    charactersList, charactersGet, charactersSet, charactersDelete,
    chatsByCharacter, chatsGet, chatsSet, chatsDelete,
    messagesByChat, messagesCount, messagesGet, messagesSet, messagesDelete,
    migrationStateGet, migrationStateSet,
};
