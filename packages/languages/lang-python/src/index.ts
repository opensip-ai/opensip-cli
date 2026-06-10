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
