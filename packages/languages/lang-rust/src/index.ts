export { rustAdapter, adapters } from './adapter.js';
export { parseRust, type RustTree } from './parse.js';
export { getSharedTree } from './shared-tree.js';
export { stripStrings, stripComments } from './strip.js';
export { rustQuery } from './query.js';
export {
  isFunction,
  isMethod,
  isStruct,
  isImpl,
  isComment,
  isString,
  isConditional,
  isLoop,
} from './predicates.js';
export { findEnclosingFunction, getEnclosingFunctionName } from './enclosing.js';

// Generic tree-sitter traversal/position vocabulary, re-exported so check
// packs reach the parser substrate THROUGH the language adapter (ADR-0039):
// the adapter owns the parser boundary; check packs depend on lang-rust +
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
