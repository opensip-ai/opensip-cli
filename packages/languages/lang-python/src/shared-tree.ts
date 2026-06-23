/**
 * Cached Python parse entry point — the analog of `lang-typescript`'s
 * `getSharedSourceFile`. Routes through `core`'s active `LanguageParseCache`
 * (key `python:filePath:fingerprint`) so a file parsed by a fitness check and
 * by the graph adapter in the same run is parsed once. Falls back to a direct
 * `adapter.parse` when no cache is active (single-check mode).
 */

import { getParseTree } from '@opensip-cli/core/languages/parse-cache.js';

import { pythonAdapter } from './adapter.js';

import type { PythonTree } from './parse.js';

/** Returns the shared (cached) Python parse tree for `filePath`, or null when unparseable. */
export function getSharedTree(filePath: string, content: string): PythonTree | null {
  return getParseTree(pythonAdapter, filePath, content);
}
