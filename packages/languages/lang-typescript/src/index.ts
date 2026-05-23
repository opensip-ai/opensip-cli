// TypeScript LanguageAdapter for opensip-tools
export { typescriptAdapter, adapters } from './adapter.js'
export { parseSource } from './parse.js'
export { typescriptQuery } from './query.js'
export { stripStrings, stripComments } from './strip.js'
export { filterContent, clearFilterCache } from './filter.js'
export type { FilteredContent } from './filter.js'

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
