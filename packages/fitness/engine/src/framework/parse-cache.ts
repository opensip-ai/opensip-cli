/**
 * @fileoverview TS SourceFile helper for framework/import-graph.ts.
 *
 * Sole export: `getSharedSourceFile`, a TS-specific convenience wrapper
 * that resolves the TypeScript adapter from the language registry and
 * parses through the language-aware cache (core/src/languages/
 * parse-cache.ts), falling back to a direct parse when no adapter is
 * registered (e.g. unit tests without CLI bootstrap).
 *
 * This file no longer re-exports the parse-cache lifecycle/getParseTree
 * API — `import-graph.ts` is its only internal consumer. New TS check
 * authors should import the canonical AST helpers from
 * @opensip-tools/lang-typescript instead.
 */


import { getParseTree, currentScope } from '@opensip-tools/core'
import ts from 'typescript'

/**
 * Get a TypeScript SourceFile via the language-aware cache when the TS
 * adapter is registered, falling back to a direct parse otherwise.
 *
 * @internal Used by framework/import-graph.ts. New TS check authors
 * should import getSharedSourceFile from @opensip-tools/lang-typescript.
 */
export function getSharedSourceFile(filePath: string, content: string): ts.SourceFile | null {
  const adapter = currentScope()?.languages.get('typescript')
  if (adapter) {
    return getParseTree(adapter, filePath, content) as ts.SourceFile | null
  }
  // No adapter registered yet (e.g. unit tests that run without CLI bootstrap).
  // Fall back to direct parse — preserves prior behavior.
  try {
    return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  /* v8 ignore start -- defensive: ts.createSourceFile is permissive (recovers from syntax errors) and effectively does not throw on real input */
  } catch {
    // @fitness-ignore-next-line error-handling-quality -- defensive parse-or-null fallback for the no-adapter-bootstrap path; ts.createSourceFile is permissive and effectively unreachable on real input (see v8 ignore above).
    return null
  }
  /* v8 ignore stop */
}
