// TypeScript LanguageAdapter for opensip-tools
export { typescriptAdapter, adapters } from './adapter.js'
export { parseSource } from './parse.js'
export { typescriptQuery } from './query.js'
export { stripStrings, stripComments, filterContent, clearFilterCache } from './strip.js'
export type { FilteredContent } from './strip.js'

// Legacy AST helpers — re-exported so existing TS checks can keep their imports
// pointing at @opensip-tools/lang-typescript instead of @opensip-tools/core/framework/*
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
  ts,
} from './ast-utilities.js'
