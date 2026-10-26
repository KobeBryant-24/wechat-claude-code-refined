import {
  openSync, writeSync, fsyncSync, closeSync,
  renameSync, unlinkSync, mkdirSync,
  readdirSync, readFileSync, existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './constants.js';
import { logger } from './logger.js';

/**
 * Per-chunk (text) and per-file persistent record.
 *
 * One file per uuid under ${DATA_DIR}/pending-store/${accountId}/.
 * Atomic write: write .tmp → fsync → rename to .json. Survives crashes
 * between fsync and rename by leaving the .tmp around; loadPendingByMtime
 * reads both .json and .tmp files (preferring .json) so nothing is lost.
 *
 * Lifecycle:
 *   enqueue       → writePendingSync (atomic)
 *   send success  → deletePendingSync
 *   send failure  → record stays on disk; worker retries with same uuid
 *   daemon restart→ loadPendingByMtime restores everything still on disk
 *   cap exceeded  → enforcePendingCap drops oldest by enqueuedAt
 */

export interface PendingRecord {
  uuid: string;
  kind: 'text' | 'file';
  toUserId: string;
  contextToken: string;
  // text chunk fields
  text?: string;
  role?: 'interstitial' | 'final';
  // file fields
  filePath?: string;
  // common
  enqueuedAt: number;
}

const PENDING_DIR = join(DATA_DIR, 'pending-store');
const MAX_PENDING_FILES = 100;

function pendingDir(accountId: string): string {
  return join(PENDING_DIR, accountId);
}

function finalPath(accountId: string, uuid: string): string {
  return join(pendingDir(accountId), `${uuid}.json`);
}

function tmpPath(accountId: string, uuid: string): string {
  return join(pendingDir(accountId), `${uuid}.json.tmp`);
}

/**
 * Atomic write: open .tmp → writeSync → fsyncSync → close → rename to .json.
 *
 * Throws on I/O error. Caller (enqueue) handles the throw by NOT pushing
 * the item into the in-memory queue — that way an unpersisted message
 * can't be sent (and then deleted) without first being on disk.
 */
export function writePendingSync(accountId: string, record: PendingRecord): void {
  const dir = pendingDir(accountId);
  mkdirSync(dir, { recursive: true });

  const tmp = tmpPath(accountId, record.uuid);
  const final = finalPath(accountId, record.uuid);

  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, JSON.stringify(record));
    fsyncSync(fd); // ★ force flush to physical disk before close
  } finally {
    closeSync(fd);
  }

  // atomic rename (POSIX/NTFS): readers see either old file or new file,
  // never a half-written one. If we crash before this line, the .tmp stays
  // on disk and loadPendingByMtime picks it up.
  renameSync(tmp, final);
}

/**
 * Delete the pending record. Idempotent: ENOENT is silently ignored.
 * Other I/O errors are re-thrown so the worker can decide whether to retry.
 */
export function deletePendingSync(accountId: string, uuid: string): void {
  try {
    unlinkSync(finalPath(accountId, uuid));
  } catch (err: any) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
}

/**
 * Load all pending records, sorted by enqueuedAt ascending.
 *
 * Reads both .json (rename completed) and .json.tmp (rename interrupted by
 * crash) files. If both exist for the same uuid, prefers .json. Skips files
 * whose JSON.parse fails (fsync-before-crash case where the .tmp content is
 * truncated) — those will be overwritten on the next enqueue.
 */
export function loadPendingByMtime(accountId: string): PendingRecord[] {
  const dir = pendingDir(accountId);
  if (!existsSync(dir)) return [];

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const recordsByUuid = new Map<string, PendingRecord>();

  for (const name of names) {
    if (!name.endsWith('.json') && !name.endsWith('.json.tmp')) continue;

    const filePath = join(dir, name);
    try {
      const content = readFileSync(filePath, 'utf8');
      const record = JSON.parse(content) as PendingRecord;

      if (
        typeof record.uuid !== 'string' ||
        (record.kind !== 'text' && record.kind !== 'file') ||
        typeof record.toUserId !== 'string'
      ) {
        logger.warn('Pending record failed validation', { file: name });
        continue;
      }

      const existing = recordsByUuid.get(record.uuid);
      // Prefer .json (rename completed) over .tmp (rename interrupted).
      if (!existing || name.endsWith('.json')) {
        recordsByUuid.set(record.uuid, record);
      }
    } catch (err) {
      logger.warn('Failed to parse pending file, will be overwritten by next enqueue', {
        file: name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return Array.from(recordsByUuid.values()).sort(
    (a, b) => a.enqueuedAt - b.enqueuedAt,
  );
}

/**
 * Clean up leftover .tmp files. Called on startup after loadPendingByMtime
 * has had a chance to read their content. Normal path: .tmp is renamed to
 * .json atomically, so a .tmp on disk means rename was interrupted; we can
 * safely delete it because loadPendingByMtime already captured the content.
 */
export function cleanupStaleTmpFiles(accountId: string): void {
  const dir = pendingDir(accountId);
  if (!existsSync(dir)) return;

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }

  for (const name of names) {
    if (!name.endsWith('.tmp')) continue;
    try {
      unlinkSync(join(dir, name));
    } catch {
      /* ignore — best effort */
    }
  }
}

/**
 * Cap the pending store at MAX_PENDING_FILES records per account, dropping
 * the oldest by enqueuedAt. Called after each write to keep the directory
 * bounded and prevent disk/memory blow-up under prolonged iLink outages.
 */
export function enforcePendingCap(accountId: string): void {
  const dir = pendingDir(accountId);
  if (!existsSync(dir)) return;

  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return;
  }

  if (names.length <= MAX_PENDING_FILES) return;

  const records: Array<{ name: string; enqueuedAt: number }> = [];
  for (const name of names) {
    try {
      const content = readFileSync(join(dir, name), 'utf8');
      const record = JSON.parse(content) as PendingRecord;
      records.push({ name, enqueuedAt: record.enqueuedAt ?? 0 });
    } catch {
      // Unparseable file — count it as ancient so it gets dropped first.
      records.push({ name, enqueuedAt: 0 });
    }
  }

  records.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  const toDrop = records.slice(0, records.length - MAX_PENDING_FILES);

  for (const r of toDrop) {
    try {
      unlinkSync(join(dir, r.name));
      logger.warn('Pending cap exceeded, dropped oldest', {
        uuid: r.name.replace(/\.json$/, ''),
        enqueuedAt: r.enqueuedAt,
        cap: MAX_PENDING_FILES,
      });
    } catch {
      /* ignore */
    }
  }
}
