/**
 * @fileoverview Detect orphaned `opensip-tools/` subtrees between cwd
 * and the discovered project root. These are fossils from pre-discovery
 * runs where `opensip-tools fit` was invoked from a subdirectory and
 * silently scaffolded a phantom project tree at that subdir.
 *
 * Conservative: only flag directories where `opensip-tools/` contains
 * EXCLUSIVELY `.runtime/` (plus optional dotfiles). Any other entry
 * (a `fit/`, a `sim/`, a `opensip-tools.config.yml` at that level) is
 * treated as legitimate user content and ignored — never warned about.
 *
 * Warn-only: returns paths. Callers print warnings to stderr but never
 * auto-delete. Auto-deletion of anything called `opensip-tools/` would
 * be too dangerous to do without explicit user invocation.
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { logger } from './logger.js';

const MODULE_TAG = 'core:phantom-detect';

/**
 * Walk every ancestor between `cwd` (inclusive) and `root` (exclusive)
 * and return the list of paths that host a phantom `opensip-tools/`.
 */
export function detectPhantomRuntimes(cwd: string, root: string): readonly string[] {
  const start = resolve(cwd);
  const stop = resolve(root);
  if (!start.startsWith(stop + sep) && start !== stop) {
    return [];
  }
  const phantoms: string[] = [];
  let dir = start;
  while (dir !== stop) {
    if (isPhantomDir(dir)) {
      phantoms.push(join(dir, 'opensip-tools'));
    }
    const parent = dirname(dir);
    if (parent === dir) break; // hit filesystem root unexpectedly
    dir = parent;
  }
  if (phantoms.length > 0) {
    logger.info({
      evt: 'cli.phantom.runtime.detected',
      module: MODULE_TAG,
      cwd: start,
      root: stop,
      phantoms,
    });
  }
  return phantoms;
}

function isPhantomDir(dir: string): boolean {
  const innerDir = join(dir, 'opensip-tools');
  if (!safeIsDirectory(innerDir)) return false;
  let entries: string[];
  try {
    entries = readdirSync(innerDir);
  } catch {
    return false;
  }
  // Conservative: only flag if `.runtime` is the only non-dotfile entry.
  const meaningful = entries.filter((name) => !name.startsWith('.') || name === '.runtime');
  return meaningful.length === 1 && meaningful[0] === '.runtime';
}

function safeIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
