export type { LanguageAdapter, LanguageQueryAPI } from './adapter.js'
export type { GenericFunction, Import, Location } from './generic-types.js'
export type { WorkspaceUnit } from './workspace-unit.js'
export { LanguageRegistry } from './registry.js'
export {
  LanguageParseCache,
  initParseCache,
  clearParseCache,
  getParseTree,
  getParseTreeForFile,
} from './parse-cache.js'
export { applyContentFilter, type ContentFilterMode } from './content-filter-dispatch.js'
export { RECOGNIZED_NON_CODE_FORMATS, isRecognizedNonCodeFormat } from './non-code-formats.js'
export {
  applyRegions,
  buildLineStarts,
  isIdentChar,
  makeStripper,
  scanBlockCommentNesting,
  scanBlockCommentNonNesting,
  scanCharLiteral,
  scanLineComment,
  scanRegularString,
} from './strip-utils.js'
export type {
  Region,
  RegStrResult,
  ScanResult,
  Stripper,
  ScanCharLiteralOptions,
  ScanCharLiteralResult,
  ScanCommentResult,
  ScanLineCommentOptions,
  ScanNestingBlockCommentResult,
  ScanRegularStringOptions,
} from './strip-utils.js'
export { buildMinimalTextTree } from './text-tree.js'
export type { MinimalTextTree } from './text-tree.js'
