// @fitness-ignore-file error-handling-quality -- every function here is best-effort cosmetic state for the "update available" notice: any failure (missing dir, malformed JSON, EACCES) must degrade silently to "nothing known" and never break the user's command. Absence and corruption are deliberately equivalent to "no update known".
// @fitness-ignore-file unbounded-memory -- reads ~/.opensip-cli/update-state.json, a tiny tool-generated cache holding a single version string.
/**
 * update-state — sticky persistence for the "update available" notice.
 *
 * `update-notifier` is a good *fetcher* (throttled — hourly here — detached
 * background network check) but a poor *display* source: its `check()`
 * deletes the cached result the instant it's read, so the notice would show
 * at most once per fetch cycle. A user who blinks past one `fit` run would
 * never see it again until the next hourly check repopulated the cache.
 *
 * This module owns the display state instead. The update notifier mirrors the
 * newest known published version here; {@link readKnownLatest} is consulted on
 * EVERY run so the notice persists, and {@link clearKnownLatest} wipes it the
 * moment the running version catches up — so it stops on its own after an
 * upgrade, with no stale "update available" lingering.
 *
 * The store is a tiny JSON file at `~/.opensip-cli/update-state.json`
 * (see {@link resolveUserPaths}), kept separate from the user-authored
 * `config.yml`. Reads and writes are best-effort: any failure degrades to
 * "nothing known" rather than breaking the command.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { resolveUserPaths } from '@opensip-cli/core';

/** On-disk shape of `~/.opensip-cli/update-state.json`. */
interface UpdateState {
  /** The newest published version the hourly check has observed. */
  readonly latest: string;
}

/** Default store path: `~/.opensip-cli/update-state.json`. */
export function defaultUpdateStateFile(): string {
  return resolveUserPaths().updateStateFile;
}

/**
 * Read the last-known newer published version, or `undefined` when nothing is
 * cached / the file is absent or unreadable. Never throws.
 */
export function readKnownLatest(file: string = defaultUpdateStateFile()): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<UpdateState>;
    return typeof parsed.latest === 'string' && parsed.latest.length > 0
      ? parsed.latest
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist the newest known published version so the notice survives across
 * runs. No-ops on any I/O failure. Skips the write when the value is unchanged
 * to avoid needless disk churn on every invocation.
 */
export function writeKnownLatest(latest: string, file: string = defaultUpdateStateFile()): void {
  if (readKnownLatest(file) === latest) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ latest } satisfies UpdateState, null, 2)}\n`, 'utf8');
  } catch {
    // Best-effort: a missing cache just means the notice falls back to
    // update-notifier's once-per-cycle behaviour. Never break the command.
  }
}

/**
 * Clear the cached version — called once the running version catches up, so
 * the notice stops on its own after an upgrade. No-ops when already absent or
 * on any I/O failure.
 */
export function clearKnownLatest(file: string = defaultUpdateStateFile()): void {
  if (!existsSync(file)) return;
  try {
    // Overwrite rather than unlink: keeps the file (and its dir perms) stable,
    // and an empty `{}` reads back as "nothing known" via readKnownLatest.
    writeFileSync(file, '{}\n', 'utf8');
  } catch {
    // Ignore — a stale file at worst re-shows a notice that clears next run.
  }
}
