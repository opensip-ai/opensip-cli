export type { LanguageAdapter, LanguageQueryAPI } from './adapter.js'
export type { GenericFunction, Import, Location } from './generic-types.js'
export { LanguageRegistry, defaultLanguageRegistry } from './registry.js'
export {
  initParseCache,
  clearParseCache,
  getParseTree,
  getParseTreeForFile,
} from './parse-cache.js'
export { applyContentFilter, type ContentFilterMode } from './content-filter-dispatch.js'
export {
  applyRegions,
  buildLineStarts,
  scanBlockCommentNesting,
  scanBlockCommentNonNesting,
  scanCharLiteral,
  scanLineComment,
  scanRegularString,
} from './strip-utils.js'
export type {
  Region,
  RegStrResult,
  ScanCharLiteralOptions,
  ScanCharLiteralResult,
  ScanCommentResult,
  ScanLineCommentOptions,
  ScanNestingBlockCommentResult,
  ScanRegularStringOptions,
} from './strip-utils.js'
export { buildMinimalTextTree } from './text-tree.js'
export type { MinimalTextTree } from './text-tree.js'
