/**
 * Cached Rust parse entry point — the analog of `lang-typescript`'s
 * `getSharedSourceFile`. Routes through `core`'s active `LanguageParseCache`
 * so a file parsed by a fitness check and by the graph adapter in the same run
 * is parsed once; falls back to a direct parse when no cache is active.
 */

import { getParseTree } from '@opensip-tools/core/languages/parse-cache.js'

import { rustAdapter } from './adapter.js'

import type { RustTree } from './parse.js'

export function getSharedTree(filePath: string, content: string): RustTree | null {
  return getParseTree(rustAdapter, filePath, content)
}
