export { javaAdapter, adapters } from './adapter.js';
export { parseJava, type JavaTree } from './parse.js';
export { getSharedTree } from './shared-tree.js';
export { stripStrings, stripComments } from './strip.js';
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
