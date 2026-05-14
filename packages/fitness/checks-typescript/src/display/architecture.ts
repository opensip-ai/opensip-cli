/**
 * @fileoverview Display entries for TypeScript-specific architecture checks
 */

import type { CheckDisplayEntry } from './types.js'

/** Architecture check display entries (TS_AST only) */
export const ARCHITECTURE_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'contracts-schema-consistency': ['📋', 'Contracts Schema Consistency'],
  'di-static-inject-usage': ['💉', 'DI Static Inject Usage'],
  'typed-inject-scope-mismatch': ['💉', 'Typed-Inject Scope Mismatch'],
  'unused-modules': ['🧹', 'Unused Modules'],
})

/** No documentation TS_AST checks; export empty object for symmetry */
export const DOCUMENTATION_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({})
