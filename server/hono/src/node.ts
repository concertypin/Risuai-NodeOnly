/**
 * @fileoverview Node.js entry point for PocketRisu Hono server.
 *
 * Environment variables:
 *   PORT          — HTTP listen port (default 6001)
 *   DATABASE_URL  — PostgreSQL connection string (optional, falls back to in-memory)
 *   HUB_URL       — Hub proxy base URL
 *   PASSWORD_HASH — Optional password hash
 *   RISU_PASSWORD — Plaintext password fallback
 */

import app from './app/index.js'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { ensureTables } from './utils/db.js'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.PORT || '6001')

async function main() {
  // Ensure save directory exists
  const savePath = join(process.cwd(), 'save')
  if (!existsSync(savePath)) {
    mkdirSync(savePath, { recursive: true })
  }

  // Ensure DB tables exist
  try {
    await ensureTables()
    console.log('[DB] Tables ensured')
  } catch (err) {
    console.error('[DB] Failed to initialize:', err)
    // Non-fatal — in-memory fallback will be used
  }

  // Static file serving for production
  const distPath = join(process.cwd(), 'dist')
  if (existsSync(distPath)) {
    app.use('/*', serveStatic({ root: './dist' }))
  }

  // Start server
  serve(
    {
      fetch: app.fetch,
      port: PORT,
    },
    (info) => {
      console.log(`[Server] PocketRisu Hono running on http://localhost:${info.port}`)
    }
  )
}

main().catch((err) => {
  console.error('[Server] Fatal error:', err)
  process.exit(1)
})
