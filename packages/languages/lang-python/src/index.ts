export { pythonAdapter, adapters } from './adapter.js';
export { parsePython, type PythonTree } from './parse.js';
export { getSharedTree } from './shared-tree.js';
export { stripStrings, stripComments } from './strip.js';
export {
  isFunction,
  isClass,
  isComment,
  isString,
  isExcept,
  isConditional,
  isLoop,
} from './predicates.js';
export { findEnclosingFunction, getEnclosingFunctionName, isMethod } from './enclosing.js';

// Generic tree-sitter traversal/position vocabulary, re-exported so check
// packs reach the parser substrate THROUGH the language adapter (ADR-0039):
// the adapter owns the parser boundary; check packs depend on lang-python +
// fitness only, never on @opensip-tools/tree-sitter directly (enforced by
// dependency-cruiser).
export {
  childrenOf,
  findEnclosing,
  getColumn,
  getLineNumber,
  nameOf,
  namedChildrenOf,
  nodeText,
  walkNodes,
  type Node,
} from '@opensip-tools/tree-sitter';
