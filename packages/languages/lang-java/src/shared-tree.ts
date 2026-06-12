// @fitness-ignore-file duplicate-utility-functions -- ADR-0010: the per-language tree-sitter vocabulary intentionally shares helper names across lang-* with grammar-specific implementations; consolidating would defeat the substrate design.
/**
 * Cached Java parse entry point — the analog of `lang-typescript`'s
 * `getSharedSourceFile`. Routes through `core`'s active `LanguageParseCache`
 * so a file parsed by a fitness check and by the graph adapter in the same run
 * is parsed once; falls back to a direct parse when no cache is active.
 */

import { getParseTree } from '@opensip-cli/core/languages/parse-cache.js';

import { javaAdapter } from './adapter.js';

import type { JavaTree } from './parse.js';

/** Returns the shared (cached) Java parse tree for `filePath`, or null when unparseable. */
export function getSharedTree(filePath: string, content: string): JavaTree | null {
  return getParseTree(javaAdapter, filePath, content);
}
