/**
 * Resolve user-supplied positional paths for `opensip yagni`.
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { ConfigurationError } from '@opensip-cli/core';

/** Resolve positional directory paths against `cwd`. */
export function resolveYagniPositionalPaths(
  paths: readonly string[],
  cwd: string,
): readonly string[] {
  const out: string[] = [];
  for (const p of paths) {
    const trimmed = p.trim();
    if (trimmed.length === 0) {
      throw new ConfigurationError('Positional path is empty.');
    }
    const abs = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
    if (!existsSync(abs)) {
      throw new ConfigurationError(`Path does not exist: '${p}' (resolved to ${abs}).`);
    }
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      throw new ConfigurationError(`Path is not readable: '${p}' (${abs}).`);
    }
    if (!isDir) {
      throw new ConfigurationError(
        `Path is not a directory: '${p}'. yagni accepts directories only.`,
      );
    }
    out.push(abs);
  }
  return out;
}
