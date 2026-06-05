export { goAdapter, adapters } from './adapter.js'
export { parseGo, type GoTree } from './parse.js'
export { getSharedTree } from './shared-tree.js'
export { stripStrings, stripComments } from './strip.js'
export {
  isFunction,
  isMethod,
  isStruct,
  isComment,
  isString,
  isConditional,
  isLoop,
} from './predicates.js'
export { findEnclosingFunction, getEnclosingFunctionName } from './enclosing.js'
