/**
 * migrate-to-tables.cjs
 * 
 * Parses database.bin and populates normalized tables for the granular API.
 * 
 * Usage: node scripts/migrate-to-tables.cjs [--dry-run]
 * 
 * This script:
 * 1. Reads database/database.bin from the save directory
 * 2. Decodes via decodeRisuSave
 * 3. Splits into normalized tables (settings, presets, modules, loadouts, characters, chats, chat_messages, plugins, plugin_storage)
 * 4. Writes migration_state marker
 */

const path = require('path');
const { readFileSync, existsSync } = require('fs');
const { decodeRisuSave, encodeRisuSaveLegacy, normalizeJSON } = require('./utils.cjs');
const {
    db: sqliteDb,
    settingsSet, settingsGetAll,
    presetsSet, presetsList,
    modulesSet, modulesList,
    loadoutsSet, loadoutsList,
    charactersSet, charactersList,
    chatsSet, chatsByCharacter,
    messagesSet, messagesCount,
    pluginsSet, pluginsList,
    pluginStorageSet, pluginStorageList,
    migrationStateGet, migrationStateSet,
} = require('./db.cjs');

const saveDir = path.join(process.cwd(), 'save');
const dbPath = path.join(saveDir, 'database.bin');

const MARKER_KEY = 'granular_api_migration';
const MARKER_VALUE = 'completed_v1';

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    
    console.log('[Migration] Starting granular API table migration...');
    console.log(`[Migration] Database path: ${dbPath}`);
    console.log(`[Migration] Dry run: ${dryRun}`);
    
    // Check if already migrated
    const existing = migrationStateGet(MARKER_KEY);
    if (existing === MARKER_VALUE) {
        console.log('[Migration] Already migrated. Skipping.');
        return;
    }
    
    // Read database.bin
    if (!existsSync(dbPath)) {
        console.error('[Migration] database.bin not found at:', dbPath);
        process.exit(1);
    }
    
    console.log('[Migration] Reading database.bin...');
    const raw = readFileSync(dbPath);
    const dbObj = normalizeJSON(await decodeRisuSave(raw));
    console.log(`[Migration] Decoded database.bin (root keys: ${Object.keys(dbObj).join(', ')})`);
    
    // 1. Settings (everything in root except known collections)
    console.log('[Migration] Extracting settings...');
    const knownCollections = new Set(['preset', 'modules', 'loadouts', 'plugins', 'pluginStorage', 'characters']);
    for (const [key, value] of Object.entries(dbObj)) {
        if (knownCollections.has(key)) continue;
        if (key === 'version' || key === 'dbversion') continue; // metadata
        settingsSet(key, value);
    }
    const settingCount = Object.keys(settingsGetAll()).length;
    console.log(`[Migration] Settings: ${settingCount} entries`);
    
    // 2. Presets
    console.log('[Migration] Extracting presets...');
    const presets = dbObj.preset || dbObj.botPresets || [];
    for (const preset of presets) {
        const id = preset.id || preset.name || `preset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        presetsSet(id, preset);
    }
    console.log(`[Migration] Presets: ${presetsList().length} entries`);
    
    // 3. Modules
    console.log('[Migration] Extracting modules...');
    const modules = dbObj.modules || [];
    for (const mod of modules) {
        const id = mod.id || mod.name || mod.uuid || `module_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        modulesSet(id, mod);
    }
    console.log(`[Migration] Modules: ${modulesList().length} entries`);
    
    // 4. Loadouts
    console.log('[Migration] Extracting loadouts...');
    const loadouts = dbObj.loadouts || [];
    for (const loadout of loadouts) {
        const id = loadout.id || loadout.name || `loadout_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        loadoutsSet(id, loadout);
    }
    console.log(`[Migration] Loadouts: ${loadoutsList().length} entries`);
    
    // 5. Plugins
    console.log('[Migration] Extracting plugins...');
    const plugins = dbObj.plugins || [];
    for (const plugin of plugins) {
        const id = plugin.id || plugin.name || `plugin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        pluginsSet(id, plugin);
    }
    console.log(`[Migration] Plugins: ${pluginsList().length} entries`);
    
    // 6. Plugin storage
    console.log('[Migration] Extracting plugin storage...');
    const pluginStorage = dbObj.pluginStorage || {};
    for (const [id, data] of Object.entries(pluginStorage)) {
        pluginStorageSet(id, data);
    }
    console.log(`[Migration] Plugin storage: ${pluginStorageList().length} entries`);
    
    // 7. Characters
    console.log('[Migration] Extracting characters...');
    const characters = dbObj.characters || {};
    for (const [chaId, charData] of Object.entries(characters)) {
        const charObj = typeof charData === 'object' ? charData : {};
        charactersSet(chaId, charObj, charObj.name, charObj.avatar || charObj.image);
        
        // Extract chats for this character
        const chats = charObj.chats || charData?.chats || [];
        console.log(`[Migration] Character ${chaId} (${charObj.name || 'unnamed'}): ${chats.length} chats`);
        
        for (const chat of chats) {
            const chatId = chat.id || chat.chat_id || chat.uuid || `chat_${chaId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const messageCount = chat.message?.length || chat.messages?.length || 0;
            const lastDate = chat.localTime || chat.lastDate || null;
            const folderId = chat.folder || chat.folderId || null;
            
            chatsSet(chatId, chaId, chat.name || chat.chatname, lastDate, folderId, messageCount);
            
            // Extract messages
            const messages = chat.message || chat.messages || [];
            for (let idx = 0; idx < messages.length; idx++) {
                messagesSet(chatId, idx, messages[idx]);
            }
        }
    }
    
    // Count total chats and messages
    const allChats = sqliteDb.prepare('SELECT COUNT(*) as count FROM chats').get();
    const allMessages = sqliteDb.prepare('SELECT COUNT(*) as count FROM chat_messages').get();
    console.log(`[Migration] Characters: ${Object.keys(characters).length}`);
    console.log(`[Migration] Total chats: ${allChats.count}`);
    console.log(`[Migration] Total messages: ${allMessages.count}`);
    
    if (dryRun) {
        console.log('[Migration] Dry run complete. No changes committed.');
        console.log('[Migration] Run without --dry-run to apply changes.');
        sqliteDb.exec('ROLLBACK');
        return;
    }
    
    // Write migration marker
    migrationStateSet(MARKER_KEY, MARKER_VALUE);
    console.log('[Migration] Migration marker set.');
    
    console.log('[Migration] Complete!');
    console.log('[Migration] Legacy database.bin is preserved. To rollback, delete the migration_state entry.');
}

main().catch(err => {
    console.error('[Migration] Fatal error:', err);
    process.exit(1);
});
