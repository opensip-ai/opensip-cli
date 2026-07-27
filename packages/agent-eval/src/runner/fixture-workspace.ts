import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { safeErrorDetail } from './error-detail.js';
import { copyFixtureInventory } from './fixture-copy-files.js';
import { listGitVisibleFixtureFiles } from './fixture-inventory.js';

import type { FixtureInventoryFile } from './fixture-inventory.js';

export interface FixtureCopySource {
  readonly fixtureDirectory: string;
  readonly repositoryRoot: string;
}

export interface FixtureWorkspaceDependencies {
  readonly removeTemporaryRoot: (path: string) => void;
}

export const DEFAULT_FIXTURE_WORKSPACE_DEPENDENCIES: FixtureWorkspaceDependencies = Object.freeze({
  removeTemporaryRoot: (path: string) => {
    rmSync(path, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
  },
});

function copyPreparedInventory(
  files: readonly FixtureInventoryFile[],
  workspaceRoot: string,
): void {
  copyFixtureInventory(files, workspaceRoot);
}

function appendCleanupFailure(primary: unknown, cleanup: unknown, temporaryRoot: string): void {
  if (!(primary instanceof Error)) return;
  const descriptor = Object.getOwnPropertyDescriptor(primary, 'message');
  if (descriptor?.writable === false) return;
  const detail = safeErrorDetail(cleanup, [temporaryRoot]) || 'unknown cleanup failure';
  primary.message = `${primary.message} Fixture cleanup also failed: ${detail}`;
}

function cleanupTemporaryRoot(
  temporaryRoot: string,
  dependencies: FixtureWorkspaceDependencies,
): { readonly ok: true } | { readonly error: unknown; readonly ok: false } {
  try {
    dependencies.removeTemporaryRoot(temporaryRoot);
    return { ok: true };
  } catch (error) {
    return { error, ok: false };
  }
}

/**
 * Copy a committed fixture outside the repository and always remove it afterward.
 *
 * @throws {Error} When the fixture is unavailable, copying fails, or the callback rejects.
 */
export async function withFixtureCopy<T>(
  source: FixtureCopySource,
  run: (workspaceRoot: string) => Promise<T>,
  dependencies: FixtureWorkspaceDependencies = DEFAULT_FIXTURE_WORKSPACE_DEPENDENCIES,
): Promise<T> {
  const files = await listGitVisibleFixtureFiles(source.fixtureDirectory, source.repositoryRoot);
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'agent-eval-'));
  const workspaceRoot = join(temporaryRoot, 'workspace');
  let outcome:
    { readonly ok: true; readonly value: T } | { readonly error: unknown; readonly ok: false };
  try {
    mkdirSync(workspaceRoot);
    copyPreparedInventory(files, workspaceRoot);
    outcome = { ok: true, value: await run(workspaceRoot) };
  } catch (error) {
    outcome = { error, ok: false };
  }
  const cleanup = cleanupTemporaryRoot(temporaryRoot, dependencies);
  if (!outcome.ok) {
    if (!cleanup.ok) appendCleanupFailure(outcome.error, cleanup.error, temporaryRoot);
    throw outcome.error;
  }
  if (!cleanup.ok) throw cleanup.error;
  return outcome.value;
}
