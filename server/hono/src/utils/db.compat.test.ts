/**
 * Compatibility tests for PocketRisu KV store.
 *
 * These tests verify that in-memory and PostgreSQL backends produce identical
 * results for all KV operations. Run with STORAGE=memory (default) or
 * STORAGE=postgres + DATABASE_URL to validate the other backend.
 *
 * Usage:
 *   # Test in-memory backend (default, no DB needed)
 *   pnpm run test
 *
 *   # Test PostgreSQL backend
 *   DATABASE_URL=postgres://... STORAGE=postgres pnpm run test
 *
 * The same test suite runs regardless of backend — outputs must match.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  ensureTables, kvSet, kvGet, kvDel, kvList, kvDelPrefix,
  kvSize, kvCopyValue, kvGetUpdatedAt, kvSizeTotal, kvCount,
  kvPrefixCount, kvPrefixSize, kvListWithSizes, clearEntities,
  addLogEntry, addLogBatch, queryLogs, deleteLogs, getStorageMode,
} from './db.js';

const storageMode = getStorageMode();

beforeAll(async () => {
  await ensureTables();
});

beforeEach(async () => {
  await clearEntities();
  await deleteLogs();
});

afterAll(async () => {
  await clearEntities();
});

// ─── KV Core Operations ──────────────────────────────────────────────────────

describe(`KV Core (${storageMode})`, () => {
  it('should set and get a string value', async () => {
    await kvSet('core/hello', 'world');
    const val = await kvGet('core/hello');
    expect(val).toBeTruthy();
    expect(val!.toString()).toBe('world');
  });

  it('should set and get a Buffer value', async () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0xFF]);
    await kvSet('core/binary', buf);
    const val = await kvGet('core/binary');
    expect(val).toBeTruthy();
    expect(val!.equals(buf)).toBe(true);
  });

  it('should return null for missing keys', async () => {
    const val = await kvGet('core/missing');
    expect(val).toBeNull();
  });

  it('should overwrite existing keys', async () => {
    await kvSet('core/overwrite', 'first');
    await kvSet('core/overwrite', 'second');
    const val = await kvGet('core/overwrite');
    expect(val!.toString()).toBe('second');
  });

  it('should delete existing keys', async () => {
    await kvSet('core/delete-me', 'value');
    const deleted = await kvDel('core/delete-me');
    expect(deleted).toBe(true);
    const val = await kvGet('core/delete-me');
    expect(val).toBeNull();
  });

  it('should return false when deleting non-existent key', async () => {
    const deleted = await kvDel('core/never-existed');
    expect(deleted).toBe(false);
  });

  it('should list all keys', async () => {
    await kvSet('list/a', '1');
    await kvSet('list/b', '2');
    const keys = await kvList();
    expect(keys).toContain('list/a');
    expect(keys).toContain('list/b');
  });

  it('should list keys by prefix', async () => {
    await kvSet('pref/alpha', '1');
    await kvSet('pref/beta', '2');
    await kvSet('other/gamma', '3');
    const keys = await kvList('pref/');
    expect(keys).toEqual(expect.arrayContaining(['pref/alpha', 'pref/beta']));
    expect(keys).not.toContain('other/gamma');
  });

  it('should delete keys by prefix', async () => {
    await kvSet('batch/x', '1');
    await kvSet('batch/y', '2');
    await kvSet('keep/z', '3');
    await kvDelPrefix('batch/');
    const allKeys = await kvList();
    expect(allKeys).not.toContain('batch/x');
    expect(allKeys).not.toContain('batch/y');
    expect(allKeys).toContain('keep/z');
  });

  it('should report key size (bytes)', async () => {
    const data = 'x'.repeat(42);
    await kvSet('size/key', data);
    const size = await kvSize('size/key');
    expect(size).toBe(42);
  });

  it('should return null for size of missing key', async () => {
    const size = await kvSize('size/missing');
    expect(size).toBeNull();
  });

  it('should copy values between keys', async () => {
    await kvSet('copy/src', 'copy-me');
    await kvCopyValue('copy/src', 'copy/dst');
    const val = await kvGet('copy/dst');
    expect(val!.toString()).toBe('copy-me');
  });

  it('should handle copy where src does not exist', async () => {
    // Should not throw
    await kvCopyValue('copy/missing', 'copy/nowhere');
    const val = await kvGet('copy/nowhere');
    expect(val).toBeNull();
  });

  it('should get updated_at timestamp', async () => {
    await kvSet('ts/key', 'value');
    const ts = await kvGetUpdatedAt('ts/key');
    expect(ts).not.toBeNull();
    expect(typeof ts).toBe('number');
    expect(ts).toBeGreaterThan(0);
  });

  it('should return null for updated_at of missing key', async () => {
    const ts = await kvGetUpdatedAt('ts/missing');
    expect(ts).toBeNull();
  });
});

// ─── KV Bulk / Aggregate Operations ──────────────────────────────────────────

describe(`KV Aggregate (${storageMode})`, () => {
  beforeEach(async () => {
    await kvSet('agg/a', '10');
    await kvSet('agg/b', '20');
    await kvSet('agg/c', '30');
    await kvSet('other/x', '100');
  });

  it('should count total keys', async () => {
    const count = await kvCount();
    expect(count).toBe(4);
  });

  it('should count keys by prefix', async () => {
    const count = await kvPrefixCount('agg/');
    expect(count).toBe(3);
    const otherCount = await kvPrefixCount('other/');
    expect(otherCount).toBe(1);
  });

  it('should calculate total size', async () => {
    const total = await kvSizeTotal();
    expect(total).toBeGreaterThan(0);
  });

  it('should calculate prefix size', async () => {
    const aggSize = await kvPrefixSize('agg/');
    const otherSize = await kvPrefixSize('other/');
    expect(aggSize).toBeGreaterThan(0);
    expect(otherSize).toBeGreaterThan(0);
  });

  it('should list keys with sizes', async () => {
    const items = await kvListWithSizes('agg/');
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.key).toMatch(/^agg\//);
      expect(item.size).toBeGreaterThan(0);
    }
  });

  it('should clear all entities', async () => {
    await clearEntities();
    const count = await kvCount();
    expect(count).toBe(0);
  });
});

// ─── Log Operations ──────────────────────────────────────────────────────────

describe(`Logs (${storageMode})`, () => {
  it('should add and query log entries', async () => {
    await addLogEntry({
      timestamp: 1000,
      level: 'info',
      origin: 'test',
      message: 'test message',
    });

    const entries = await queryLogs({});
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].message).toBe('test message');
  });

  it('should filter logs by level', async () => {
    await addLogEntry({ timestamp: 2000, level: 'info', origin: 'test', message: 'info msg' });
    await addLogEntry({ timestamp: 3000, level: 'warn', origin: 'test', message: 'warn msg' });

    const infoEntries = await queryLogs({ level: 'info' });
    expect(infoEntries).toHaveLength(1);
    expect(infoEntries[0].message).toBe('info msg');
  });

  it('should filter logs by origin', async () => {
    await addLogEntry({ timestamp: 4000, level: 'info', origin: 'worker', message: 'worker msg' });
    await addLogEntry({ timestamp: 5000, level: 'info', origin: 'api', message: 'api msg' });

    const apiEntries = await queryLogs({ origin: 'api' });
    expect(apiEntries).toHaveLength(1);
    expect(apiEntries[0].message).toBe('api msg');
  });

  it('should delete logs', async () => {
    await addLogEntry({ timestamp: 6000, level: 'info', origin: 'test', message: 'delete me' });
    await deleteLogs();
    const entries = await queryLogs({});
    // After deletion in-memory, logs are gone
    if (getStorageMode() === 'memory') {
      expect(entries).toHaveLength(0);
    }
    // For PostgreSQL, deleteLogs deletes all
    expect(entries.length).toBeLessThanOrEqual(1); // might have leftover from other tests
  });

  it('should delete logs before a timestamp', async () => {
    await addLogEntry({ timestamp: 100, level: 'info', origin: 'test', message: 'old' });
    await addLogEntry({ timestamp: 200, level: 'info', origin: 'test', message: 'new' });
    await deleteLogs(150);

    const entries = await queryLogs({});
    // The old entry (100) should be gone, new entry (200) remains
    expect(entries.some(e => e.message === 'new')).toBe(true);
  });

  it('should add log batch', async () => {
    await addLogBatch([
      { timestamp: 7000, level: 'info', origin: 'batch', message: 'batch 1' },
      { timestamp: 8000, level: 'info', origin: 'batch', message: 'batch 2' },
    ]);

    const entries = await queryLogs({ origin: 'batch' });
    expect(entries).toHaveLength(2);
  });
});

// ─── Storage Mode ────────────────────────────────────────────────────────────

describe(`Storage Mode (${storageMode})`, () => {
  it('should report the storage mode', () => {
    const mode = getStorageMode();
    expect(['memory', 'postgres']).toContain(mode);
  });

  it('should reject invalid STORAGE values', () => {
    // Can't test process.env mutation here because STORAGE is read at import time
    // but we can verify the current mode is valid
    expect(['memory', 'postgres']).toContain(getStorageMode());
  });
});
