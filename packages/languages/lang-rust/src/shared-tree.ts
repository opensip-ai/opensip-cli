/**
 * Cached Rust parse entry point — the analog of `lang-typescript`'s
 * `getSharedSourceFile`. Routes through `core`'s active `LanguageParseCache`
 * so a file parsed by a fitness check and by the graph adapter in the same run
 * is parsed once; falls back to a direct parse when no cache is active.
 */

import { getParseTree } from '@opensip-cli/core/languages/parse-cache.js';

import { rustAdapter } from './adapter.js';

import type { RustTree } from './parse.js';

/** Returns the shared (cached) Rust parse tree for `filePath`, or null when unparseable. */
export function getSharedTree(filePath: string, content: string): RustTree | null {
  return getParseTree(rustAdapter, filePath, content);
}
