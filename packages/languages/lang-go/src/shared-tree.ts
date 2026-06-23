/**
 * Cached Go parse entry point — the analog of `lang-typescript`'s
 * `getSharedSourceFile`. Routes through `core`'s active `LanguageParseCache`
 * so a file parsed by a fitness check and by the graph adapter in the same run
 * is parsed once; falls back to a direct parse when no cache is active.
 */

import { getParseTree } from '@opensip-cli/core/languages/parse-cache.js';

import { goAdapter } from './adapter.js';

import type { GoTree } from './parse.js';

/** Returns the shared (cached) Go parse tree for `filePath`, or null when unparseable. */
export function getSharedTree(filePath: string, content: string): GoTree | null {
  return getParseTree(goAdapter, filePath, content);
}
