/**
 * @fileoverview Re-export from the language-aware parse cache.
 *
 * The init/clear lifecycle and getParseTree API live in
 * core/src/languages/parse-cache.ts. This file forwards those calls.
 *
 * getSharedSourceFile is a temporary TS-direct shim retained until
 * Phase 2 lands @opensip-tools/lang-typescript. After Phase 2 migrates
 * all callers, this entire file can become a pure re-export with no
 * `typescript` dependency.
 */

import ts from 'typescript'

export {
  initParseCache,
  clearParseCache,
  getParseTree,
  getParseTreeForFile,
} from '../languages/parse-cache.js'

/**
 * @deprecated Phase 2 will move this to @opensip-tools/lang-typescript.
 *
 * Temporary shim: parses TS directly without using the language-aware
 * cache. Cache hits are not provided here because the TS adapter is not
 * registered in core. Phase 2 routes this through getParseTree(typescriptAdapter, ...).
 */
export function getSharedSourceFile(filePath: string, content: string): ts.SourceFile | null {
  try {
    return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  } catch {
    return null
  }
}
