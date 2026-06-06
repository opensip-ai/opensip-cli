/**
 * @fileoverview Display entries for TypeScript-specific architecture checks
 */

import type { CheckDisplayEntry } from './types.js'

/** Architecture check display entries (TS_AST only) */
export const ARCHITECTURE_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'circular-import-detection': ['🔁', 'Circular Import Detection'],
  'contracts-schema-consistency': ['📋', 'Contracts Schema Consistency'],
  'drizzle-orm-migration-guardrails': ['🛡️', 'Drizzle ORM Migration Guardrails'],
  'missing-type-exports': ['📤', 'Missing Type Exports'],
  'module-coupling-fan-out': ['🕸️', 'Module Coupling Fan-Out'],
  'package-json-exports-field': ['📦', 'package.json Exports Field'],
  'phantom-dependency-detection': ['📦', 'Phantom Dependency Detection'],
  'tsconfig-extends-validation': ['⚙️', 'tsconfig Extends Validation'],
})

/** No documentation TS_AST checks; export empty object for symmetry */
export const DOCUMENTATION_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({})
