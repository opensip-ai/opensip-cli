// TypeScript LanguageAdapter for opensip-tools

// Re-export the TypeScript namespace as a first-class top-level export so the
// barrel surface is the single source of truth for `ts` access. Done as a
// namespace import + named export because `export * as ts from 'typescript'`
// is invalid against typescript's `export =` shape.
import * as ts from 'typescript';
// eslint-disable-next-line unicorn/prefer-export-from -- `export * as from 'typescript'` is invalid (typescript uses `export =`); the namespace import + named export form is the only working shape
export { ts };

export { typescriptAdapter, adapters } from './adapter.js';
export { parseSource } from './parse.js';
export { typescriptQuery } from './query.js';
export { stripStrings, stripComments } from './strip.js';
export { filterContent } from './filter.js';
export type { FilteredContent } from './filter.js';
export { discoverTypescriptWorkspaceUnits } from './workspace-units.js';

// Function-scope helpers — extracted from `ast-utilities.ts` into a
// concern-named module. New scope helpers go in `./function-scope.ts`,
// NOT in `ast-utilities.ts`.
export {
  findEnclosingFunction,
  findEnclosingFunctionBody,
  getEnclosingFunctionName,
  findEnclosingScope,
  isAsync,
  isInAsyncContext,
  isInsideConditionalBlock,
} from './function-scope.js';
export type { FunctionLikeNode } from './function-scope.js';

// Canonical TS AST helpers — the compiler-API utilities check packs use.
// Re-exported so TS checks import them from @opensip-tools/lang-typescript.
// The `ts` re-export from this module is intentionally NOT re-surfaced here
// (it now lives at the top of the barrel above).
export {
  getSharedSourceFile,
  walkNodes,
  getIdentifierName,
  getPropertyChain,
  getLineNumber,
  getColumn,
  isPropertyAccess,
  isLiteral,
  isInStringLiteral,
  findCallExpressions,
  findBinaryExpressions,
  findTemplateLiterals,
  isInComment,
  countUnescapedBackticks,
} from './ast-utilities.js';
