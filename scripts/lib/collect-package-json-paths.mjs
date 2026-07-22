/**
 * @fileoverview Recursive package.json path collector shared by the npm
 * metadata generators (`build-package-keywords.mjs`, `build-package-readmes.mjs`):
 * walks a directory tree and returns every `package.json` found, skipping
 * build/vendor/tooling directories that are never workspace packages.
 *
 * @module scripts/lib/collect-package-json-paths
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.claude', 'coverage']);

/** Recursively collect every package.json path under packages/. */
export function collectPackageJsonPaths(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectPackageJsonPaths(join(dir, entry.name), out);
    } else if (entry.name === 'package.json') {
      out.push(join(dir, entry.name));
    }
  }
}
