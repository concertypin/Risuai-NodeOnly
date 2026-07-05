import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { registerRoutes } from '../utils/routes.js'

const app = new Hono()

// ── Global middleware ────────────────────────────────────────────────────────
app.use('*', logger())
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Cookie', 'file-path', 'key-prefix',
    'x-if-match', 'x-session-id', 'risu-url', 'risu-header', 'risu-timeout-ms',
    'x-risu-tk', 'x-risu-node-path', 'if-none-match'],
  credentials: true,
}))
app.use('*', csrf({ origin: '*' }))
app.use('*', secureHeaders())

// ── Register all routes ─────────────────────────────────────────────────────
registerRoutes(app)

export default app
