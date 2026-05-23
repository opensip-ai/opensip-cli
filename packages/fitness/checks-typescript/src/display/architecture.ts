/**
 * @fileoverview Display entries for TypeScript-specific architecture checks
 */

import type { CheckDisplayEntry } from './types.js'

/** Architecture check display entries (TS_AST only) */
export const ARCHITECTURE_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'circular-import-detection': ['🔁', 'Circular Import Detection'],
  'contracts-schema-consistency': ['📋', 'Contracts Schema Consistency'],
  'di-static-inject-usage': ['💉', 'DI Static Inject Usage'],
  'drizzle-orm-migration-guardrails': ['🛡️', 'Drizzle ORM Migration Guardrails'],
  'missing-type-exports': ['📤', 'Missing Type Exports'],
  'module-coupling-fan-out': ['🕸️', 'Module Coupling Fan-Out'],
  'package-json-exports-field': ['📦', 'package.json Exports Field'],
  'tsconfig-extends-validation': ['⚙️', 'tsconfig Extends Validation'],
  'typed-inject-scope-mismatch': ['💉', 'Typed-Inject Scope Mismatch'],
  'unused-modules': ['🧹', 'Unused Modules'],
})

/** No documentation TS_AST checks; export empty object for symmetry */
export const DOCUMENTATION_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({})
