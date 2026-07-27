import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { WorkspacePreparationError } from './workspace-preparation-error.js';

import type { FixtureInventoryFile } from './fixture-inventory.js';

/** Copy one bounded, prevalidated inventory into a disposable workspace. */
export function copyFixtureInventory(
  files: readonly FixtureInventoryFile[],
  workspaceRoot: string,
): void {
  for (const [index, file] of files.entries()) {
    const destination = join(workspaceRoot, file.relativePath);
    try {
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(file.absolutePath, destination);
    } catch (error) {
      throw new WorkspacePreparationError('fixture-copy', index, error);
    }
  }
}
