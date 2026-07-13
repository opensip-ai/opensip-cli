import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { copyFixtureInventory } from './fixture-copy-files.js';
import { listGitVisibleFixtureFiles } from './fixture-inventory.js';

import type { FixtureInventoryFile } from './fixture-inventory.js';

export interface FixtureCopySource {
  readonly fixtureDirectory: string;
  readonly repositoryRoot: string;
}

function copyPreparedInventory(
  files: readonly FixtureInventoryFile[],
  workspaceRoot: string,
): void {
  copyFixtureInventory(files, workspaceRoot);
}

/**
 * Copy a committed fixture outside the repository and always remove it afterward.
 *
 * @throws {Error} When the fixture is unavailable, copying fails, or the callback rejects.
 */
export async function withFixtureCopy<T>(
  source: FixtureCopySource,
  run: (workspaceRoot: string) => Promise<T>,
): Promise<T> {
  const files = await listGitVisibleFixtureFiles(source.fixtureDirectory, source.repositoryRoot);
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'agent-eval-'));
  const workspaceRoot = join(temporaryRoot, 'workspace');
  try {
    mkdirSync(workspaceRoot);
    copyPreparedInventory(files, workspaceRoot);
    return await run(workspaceRoot);
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}
