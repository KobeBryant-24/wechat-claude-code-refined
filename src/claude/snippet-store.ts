/**
 * Snippet store — durable home for message bodies that the tool-noise filter
 * decided to compress away.
 *
 * The filter exists because some providers inject raw tool I/O into the text
 * stream, which floods WeChat. But collapsing such a message to one line is
 * lossy, and the loss is silent: a 2539-char answer collapsed to 49 chars with
 * no way to recover it. So a hit no longer discards anything — the original is
 * written here, a short stand-in goes to WeChat, and the full text stays
 * retrievable for a week.
 *
 * Files are named `<id>.md` under `~/.wechat-claude-code/snippets/`. `.md` is in
 * the bridge's AUTO_PUSH_EXTENSIONS, so a hit can hand the file straight to
 * WeChat via `sender.enqueueFile`.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../constants.js';
import { logger } from '../logger.js';

const SNIPPETS_DIR = join(DATA_DIR, 'snippets');

/**
 * Snippets are kept a week. Long enough that "I need that message again" is
 * never missed because of a deploy, short enough that the directory doesn't
 * grow without bound. Cleanup is best-effort and runs at startup — there is no
 * timer, because a bridge that is never restarted would otherwise never sweep.
 */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Ids are user-typable (`/show a1b2c3d4`) and get joined onto a filesystem path,
 * so the charset is restricted to lowercase hex. Anything else — `../../`,
 * absolute paths, names with dots — is rejected before it reaches `join`.
 */
const ID_PATTERN = /^[0-9a-f]{8}$/;

export function isValidSnippetId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export interface SavedSnippet {
  id: string;
  path: string;
  charCount: number;
}

/**
 * Persist `text` and return its id. Retries on the (astronomically unlikely)
 * id collision rather than overwriting an existing snippet.
 */
export function saveSnippet(text: string): SavedSnippet {
  mkdirSync(SNIPPETS_DIR, { recursive: true });

  let id = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = randomBytes(4).toString('hex');
    if (!existsSync(join(SNIPPETS_DIR, `${candidate}.md`))) {
      id = candidate;
      break;
    }
  }
  if (!id) {
    // 5 collisions in a row means something is wrong with the directory, not
    // with randomness. Throwing here surfaces it instead of silently dropping.
    throw new Error('could not allocate a free snippet id');
  }

  const path = join(SNIPPETS_DIR, `${id}.md`);
  writeFileSync(path, text, 'utf8');
  return { id, path, charCount: text.length };
}

/** Absolute path a snippet id maps to. Returns undefined for a malformed id. */
export function snippetPath(id: string): string | undefined {
  if (!isValidSnippetId(id)) return undefined;
  return join(SNIPPETS_DIR, `${id}.md`);
}

/** Read a snippet back by id. Returns undefined when missing or unreadable. */
export function readSnippet(id: string): string | undefined {
  const path = snippetPath(id);
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Delete snippets older than the retention window. Called once at daemon
 * startup; returns how many were removed so the caller can log it.
 */
export function cleanupExpiredSnippets(now = Date.now()): number {
  let entries: string[];
  try {
    entries = readdirSync(SNIPPETS_DIR);
  } catch {
    return 0; // directory absent — nothing has ever been stored yet
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const path = join(SNIPPETS_DIR, entry);
    try {
      if (now - statSync(path).mtimeMs > RETENTION_MS) {
        unlinkSync(path);
        removed++;
      }
    } catch (err) {
      // One unreadable entry must not abort the sweep.
      logger.warn('Snippet cleanup: skipping entry', {
        entry,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return removed;
}