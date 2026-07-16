import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { FixtureInventoryFile } from './fixture-inventory.js';

/** Copy one bounded, prevalidated inventory into a disposable workspace. */
export function copyFixtureInventory(
  files: readonly FixtureInventoryFile[],
  workspaceRoot: string,
): void {
  for (const file of files) {
    const destination = join(workspaceRoot, file.relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(file.absolutePath, destination);
  }
}
