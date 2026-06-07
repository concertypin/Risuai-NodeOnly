/**
 * migrate-sqlite-to-pg.cjs
 * 
 * Migrates data from SQLite to PostgreSQL.
 * 
 * Usage: node scripts/migrate-sqlite-to-pg.cjs <sqlite-path> <postgresql-url>
 * 
 * Example:
 *   node scripts/migrate-sqlite-to-pg.cjs save/risuai.db postgresql://user:pass@localhost:5432/risuai
 * 
 * Environment variables:
 *   DB_SSL_MODE=require  (for cloud PostgreSQL)
 *   DB_POOL_SIZE=20      (connection pool size)
 */

const path = require('path');
const { migrateSQLiteToPostgreSQL } = require('./db-adapter.cjs');

async function main() {
    const sqlitePath = process.argv[2];
    const pgUrl = process.argv[3];

    if (!sqlitePath || !pgUrl) {
        console.error('Usage: node migrate-sqlite-to-pg.cjs <sqlite-path> <postgresql-url>');
        console.error('');
        console.error('Example:');
        console.error('  node migrate-sqlite-to-pg.cjs save/risuai.db postgresql://user:pass@localhost:5432/risuai');
        console.error('');
        console.error('Environment variables:');
        console.error('  DB_SSL_MODE=require  (for cloud PostgreSQL)');
        console.error('  DB_POOL_SIZE=20      (connection pool size)');
        process.exit(1);
    }

    console.log('[Migration] SQLite path:', sqlitePath);
    console.log('[Migration] PostgreSQL URL:', pgUrl.replace(/:\/\/[^:]+:[^@]+@/, '://***:***@'));
    console.log('');

    await migrateSQLiteToPostgreSQL(sqlitePath, pgUrl);

    console.log('');
    console.log('[Migration] Next steps:');
    console.log('  1. Set DATABASE_URL=' + pgUrl.replace(/:\/\/[^:]+:[^@]+@/, '://***:***@'));
    console.log('  2. Restart the server');
    console.log('  3. Verify data integrity');
}

main().catch(err => {
    console.error('[Migration] Fatal error:', err);
    process.exit(1);
});
