/**
 * Shared utility — normalize a project directory path.
 *
 * Two callers per spec §2.1: stage 0 (discover) and stage 2 (edges).
 * Cache invalidation also normalizes tsConfigPath the same way, making
 * three callers and justifying extraction (rule of three).
 */

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { ConfigurationError } from '@opensip-tools/core';

/**
 * Normalize a project directory: resolve to absolute, then realpath
 * (follows symlinks). Throws ConfigurationError if missing or not a
 * directory.
 */
export function normalizeProjectDir(input: string): string {
  const absolute = isAbsolute(input) ? input : resolve(input);
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    throw new ConfigurationError(`Project directory does not exist: ${input}`);
  }
  if (!stat.isDirectory()) {
    throw new ConfigurationError(`Project path is not a directory: ${input}`);
  }
  try {
    return realpathSync(absolute);
  } catch {
    /* v8 ignore next */
    return absolute;
  }
}
