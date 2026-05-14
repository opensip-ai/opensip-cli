/**
 * @fileoverview Re-export from the language-aware parse cache.
 *
 * The init/clear lifecycle and getParseTree API live in
 * core/src/languages/parse-cache.ts. This file forwards those calls
 * for backward compatibility with code that imported from this path.
 *
 * getSharedSourceFile remains as a TS-specific convenience wrapper
 * that resolves the TypeScript adapter from the language registry.
 * Phase 2 moved the canonical TS AST helpers to
 * @opensip-tools/lang-typescript; this shim is retained for the
 * core framework/import-graph.ts internal use case.
 */


import { getParseTree , defaultLanguageRegistry } from '@opensip-tools/core'
import ts from 'typescript'

export {
  initParseCache,
  clearParseCache,
  getParseTree,
  getParseTreeForFile,
} from '@opensip-tools/core'

/**
 * Get a TypeScript SourceFile via the language-aware cache when the TS
 * adapter is registered, falling back to a direct parse otherwise.
 *
 * @internal Used by framework/import-graph.ts. New TS check authors
 * should import getSharedSourceFile from @opensip-tools/lang-typescript.
 */
export function getSharedSourceFile(filePath: string, content: string): ts.SourceFile | null {
  const adapter = defaultLanguageRegistry.get('typescript')
  if (adapter) {
    return getParseTree(adapter, filePath, content) as ts.SourceFile | null
  }
  // No adapter registered yet (e.g. unit tests that run without CLI bootstrap).
  // Fall back to direct parse — preserves prior behavior.
  try {
    return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  } catch {
    return null
  }
}
