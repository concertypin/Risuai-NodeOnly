/**
 * @fileoverview Auth & session management for PocketRisu Hono server.
 *
 * Ported from server/node/server.cjs (lines ~792-812, ~1334-1460).
 *
 * Environment variables:
 *   PASSWORD_HASH  — optional bcrypt hash for password-protected instances
 *   JWT_SECRET     — optional override for JWT signing secret
 */

import { type Context, type Next } from 'hono';
import { setCookie, getCookie } from 'hono/cookie';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── JWT Secret ──────────────────────────────────────────────────────────────

const savePath = join(process.cwd(), 'save');
if (!existsSync(savePath)) {
  mkdirSync(savePath, { recursive: true });
}

const jwtSecretPath = join(savePath, '__jwt_secret');
let jwtSecret: string;
if (existsSync(jwtSecretPath)) {
  jwtSecret = readFileSync(jwtSecretPath, 'utf-8').trim();
} else {
  jwtSecret = randomBytes(64).toString('hex');
  writeFileSync(jwtSecretPath, jwtSecret, 'utf-8');
}

// Allow override via env
if (process.env.JWT_SECRET) {
  jwtSecret = process.env.JWT_SECRET;
}

// ─── Sessions (in-memory) ────────────────────────────────────────────────────

const sessions = new Map<string, number>();

export function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(token);
  }
}

// Clean expired sessions every 5 minutes
setInterval(cleanExpiredSessions, 5 * 60 * 1000);

// ─── Cookie Helpers ──────────────────────────────────────────────────────────

function parseSessionCookie(c: Context): string | undefined {
  return getCookie(c, 'risuai_session');
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Session auth middleware. Protects endpoints that require an active session.
 */
export async function sessionAuthMiddleware(c: Context, next: Next): Promise<Response | void> {
  const token = parseSessionCookie(c);
  if (token && (sessions.get(token) ?? 0) > Date.now()) {
    return next();
  }
  return c.body(null, 401);
}

/**
 * Check if the request has a valid session, optionally returning only status.
 * Port of server.cjs checkAuth() (line 2397).
 */
export async function checkAuth(
  c: Context,
  options: { returnOnlyStatus?: boolean; allowExpired?: boolean } = {}
): Promise<boolean> {
  const token = parseSessionCookie(c);
  if (!token) {
    return false;
  }

  const expiresAt = sessions.get(token);
  if (!expiresAt) {
    return false;
  }

  if (expiresAt <= Date.now()) {
    if (!options.allowExpired) {
      sessions.delete(token);
      return false;
    }
    return true; // allow even if expired
  }

  return true;
}

/**
 * Auth guard for routes — returns 401 if not authenticated.
 */
export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  if (await checkAuth(c)) {
    return next();
  }
  return c.json({ error: 'Unauthorized' }, 401);
}

/**
 * Active session lock: only one session can write at a time.
 * Port of server.cjs checkActiveSession() (line 1406).
 */
let activeSessionId: string | null = null;

export function setActiveSession(sessionId: string | null): void {
  activeSessionId = sessionId;
}

export function checkActiveSession(c: Context): boolean {
  const clientSessionId = c.req.header('x-session-id');
  if (!clientSessionId) return true; // client without session support
  if (!activeSessionId) return true;
  if (clientSessionId === activeSessionId) return true;
  return false;
}

export async function requireActiveSession(c: Context, next: Next): Promise<Response | void> {
  if (checkActiveSession(c)) {
    return await next();
  }
  return c.json({ error: 'Session deactivated' }, 423) as unknown as Response;
}

// ─── Session CRUD ────────────────────────────────────────────────────────────

export function createSession(durationMs: number = 30 * 24 * 60 * 60 * 1000): string {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + durationMs);
  return token;
}

export function refreshSession(token: string, durationMs: number = 30 * 24 * 60 * 60 * 1000): boolean {
  const expiresAt = sessions.get(token);
  if (!expiresAt) return false;
  sessions.set(token, Date.now() + durationMs);
  return true;
}

export function deleteSession(token: string): boolean {
  return sessions.delete(token);
}

// ─── JWT Helpers ─────────────────────────────────────────────────────────────

export function createServerJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { iat: now, exp: now + 5 * 60 };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', jwtSecret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');
  return `${headerB64}.${payloadB64}.${sig}`;
}

// ─── Password ────────────────────────────────────────────────────────────────

let passwordHash: string | null = process.env.PASSWORD_HASH ?? null;

export function setPasswordHash(hash: string | null): void {
  passwordHash = hash;
}

export function getPasswordHash(): string | null {
  return passwordHash ?? process.env.PASSWORD_HASH ?? null;
}
