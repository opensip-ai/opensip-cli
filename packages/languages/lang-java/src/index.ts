export { javaAdapter, adapters } from './adapter.js';
export { parseJava, type JavaTree } from './parse.js';
export { getSharedTree } from './shared-tree.js';
export { stripStrings, stripComments } from './strip.js';
export { javaQuery } from './query.js';
export {
  isFunction,
  isMethod,
  isConstructor,
  isClass,
  isComment,
  isString,
  isCatch,
  isConditional,
  isLoop,
} from './predicates.js';
export { findEnclosingFunction, getEnclosingFunctionName } from './enclosing.js';

// Generic tree-sitter traversal/position vocabulary, re-exported so check
// packs reach the parser substrate THROUGH the language adapter (ADR-0039):
// the adapter owns the parser boundary; check packs depend on lang-java +
// fitness only, never on @opensip-cli/tree-sitter directly (enforced by
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
} from '@opensip-cli/tree-sitter';
