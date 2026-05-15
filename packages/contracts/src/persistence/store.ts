/**
 * JSON file persistence for opensip-tools results.
 *
 * Sessions land at `<project>/opensip-tools/.runtime/sessions/`
 * (per-project). Each run creates one file:
 * `{timestamp}-{tool}-{recipe}.json`.
 *
 * The CLI bootstrap calls `configurePersistencePaths(projectPaths)`
 * once on startup with paths from `resolveProjectPaths(cwd)`. Until
 * that call, the module falls back to a user-global location
 * (`~/.opensip-tools/`) so any caller who imports persistence helpers
 * before the CLI's preAction hook still gets a valid path. The
 * fallback is also exercised by tests that don't bootstrap a CLI.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { logger } from '@opensip-tools/core';

import type { ProjectPaths } from '@opensip-tools/core';

export interface StoredSession {
  readonly id: string;
  readonly tool: 'fit' | 'sim';
  readonly timestamp: string;
  readonly cwd: string;
  readonly recipe?: string;
  readonly score: number;
  readonly passed: boolean;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly errors: number;
    readonly warnings: number;
  };
  readonly checks: readonly {
    readonly checkSlug: string;
    readonly passed: boolean;
    readonly violationCount?: number;
    readonly findings: readonly {
      readonly ruleId: string;
      readonly message: string;
      readonly severity: string;
      readonly filePath?: string;
      readonly line?: number;
      readonly column?: number;
      readonly suggestion?: string;
      readonly category?: string;
    }[];
    readonly durationMs: number;
  }[];
  readonly durationMs: number;
}

/** Check catalog entry for dashboard display */
export interface CheckCatalogEntry {
  readonly slug: string;
  readonly name: string;
  readonly icon: string;
  readonly description: string;
  readonly longDescription?: string;
  readonly tags: readonly string[];
  readonly confidence: 'high' | 'medium' | 'low';
  readonly source: 'built-in' | 'community';
}

/** Recipe catalog entry for dashboard display */
export interface RecipeCatalogEntry {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly selectorType: string;
  readonly mode: string;
  readonly timeout: number;
}

/**
 * Fallback path: user-global `~/.opensip-tools/`, used by tests and
 * any code path that imports persistence helpers before the CLI has
 * called `configurePersistencePaths`. New code should not rely on
 * this fallback — call `configurePersistencePaths` first.
 */
export const TOOLS_HOME = join(homedir(), '.opensip-tools');

/** Mutable per-process state — set by `configurePersistencePaths`. */
let storeDir: string = join(TOOLS_HOME, 'sessions');
let reportsDir: string = join(TOOLS_HOME, 'reports');
const MAX_SESSIONS = 100;

/**
 * Configure where this module writes sessions and reports. Called
 * once by the CLI bootstrap with the project paths. Idempotent and
 * safe to call repeatedly (e.g. tests that switch project dirs).
 */
export function configurePersistencePaths(paths: Pick<ProjectPaths, 'sessionsDir' | 'reportsDir'>): void {
  storeDir = paths.sessionsDir;
  reportsDir = paths.reportsDir;
}

/** Ensure directory exists — mkdirSync with recursive is idempotent */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Sanitize a string for use in a filename — strip path separators and special chars */
export function sanitizeForFilename(s: string): string {
  return s.replaceAll('..', '-').replaceAll(/[/\\:*?"<>|.]/g, '-');
}

/** Save a session result to disk */
export function saveSession(session: StoredSession): string {
  ensureDir(storeDir);
  const safeRecipe = session.recipe ? `-${sanitizeForFilename(session.recipe)}` : '';
  const filename = `${session.timestamp.replaceAll(/[:.]/g, '-')}-${session.tool}${safeRecipe}.json`;
  // Ensure filename stays within the sessions directory
  const filepath = join(storeDir, basename(filename));
  writeFileSync(filepath, JSON.stringify(session, null, 2), 'utf8');

  pruneOldSessions();
  return filepath;
}

/** Count session files in the store directory */
export function countSessions(): number {
  ensureDir(storeDir);
  return readdirSync(storeDir).filter(f => f.endsWith('.json')).length;
}

/** Delete all sessions. Returns the number of files deleted. */
export function clearAllSessions(): number {
  ensureDir(storeDir);
  const files = readdirSync(storeDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    unlinkSync(join(storeDir, file));
  }
  return files.length;
}

/** Delete sessions older than the given number of days. Returns the number of files deleted. */
export function clearSessionsOlderThan(days: number): number {
  ensureDir(storeDir);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const files = readdirSync(storeDir).filter(f => f.endsWith('.json'));
  let deleted = 0;

  for (const file of files) {
    try {
      const filepath = join(storeDir, file);
      const raw = readFileSync(filepath, 'utf8');
      const session = JSON.parse(raw) as { timestamp?: string };
      if (session.timestamp) {
        const sessionTime = new Date(session.timestamp).getTime();
        if (!Number.isNaN(sessionTime) && sessionTime < cutoff) {
          unlinkSync(filepath);
          deleted++;
        }
      }
    } catch {
      // Skip files that can't be read/parsed
    }
  }

  return deleted;
}

/** Load all sessions, newest first. Optional limit to avoid reading everything. */
export function loadSessions(limit?: number): StoredSession[] {
  ensureDir(storeDir);
  const files = readdirSync(storeDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    // eslint-disable-next-line unicorn/no-array-reverse -- target ES2022; Array#toReversed is ES2023 and not in the lib
    .reverse();

  const toRead = limit ? files.slice(0, limit) : files;
  const sessions: StoredSession[] = [];
  for (const file of toRead) {
    try {
      const raw = readFileSync(join(storeDir, file), 'utf8');
      sessions.push(JSON.parse(raw) as StoredSession);
    } catch {
      // Warn about corrupted files — don't crash
      logger.warn({ evt: 'cli.session.corrupted', module: 'cli:persistence', msg: `Skipping corrupted session file: ${file}`, file });
    }
  }
  return sessions;
}

/** Load the most recent session */
export function loadLatestSession(): StoredSession | null {
  const sessions = loadSessions(1);
  return sessions[0] ?? null;
}

/** Prune sessions beyond the max count */
function pruneOldSessions(): void {
  const files = readdirSync(storeDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    // eslint-disable-next-line unicorn/no-array-reverse -- target ES2022; Array#toReversed is ES2023 and not in the lib
    .reverse();

  if (files.length <= MAX_SESSIONS) return;

  for (const file of files.slice(MAX_SESSIONS)) {
    try {
      unlinkSync(join(storeDir, file));
    } catch {
      // Best effort
    }
  }
}

/** Get the store directory path */
export function getStoreDir(): string {
  return storeDir;
}

/** Get the reports directory path, creating it if needed */
export function getReportsDir(): string {
  ensureDir(reportsDir);
  return reportsDir;
}

/** Generate a unique session ID */
export function generateSessionId(): string {
  return randomUUID();
}
