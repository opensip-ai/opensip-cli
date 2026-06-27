/**
 * @fileoverview Display entries for TypeScript-specific architecture checks
 */

import type { CheckDisplayEntry } from './types.js';

/** Architecture check display entries (TS_AST only) */
export const ARCHITECTURE_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'circular-import-detection': ['🔁', 'Circular Import Detection'],
  'command-handler-host-owned-output': ['🚪', 'Command Handler Host-Owned Output'],
  'contracts-schema-consistency': ['📋', 'Contracts Schema Consistency'],
  'drizzle-orm-migration-guardrails': ['🛡️', 'Drizzle ORM Migration Guardrails'],
  'host-tool-runtime-import-boundary': ['🧱', 'Host Tool Runtime Import Boundary'],
  'live-view-through-cli-live': ['🖥️', 'Live View Through cli-live'],
  'missing-type-exports': ['📤', 'Missing Type Exports'],
  'module-coupling-fan-out': ['🕸️', 'Module Coupling Fan-Out'],
  'no-bootstrap-tool-import': ['🔌', 'No Bootstrap Tool Import'],
  'architecture-no-run-done-result': ['🎯', 'No Per-Tool Run Done-Result'],
  'package-json-exports-field': ['📦', 'package.json Exports Field'],
  'phantom-dependency-detection': ['📦', 'Phantom Dependency Detection'],
  'subprocess-correlation-required': ['🔗', 'Subprocess Correlation Required'],
  'tsconfig-extends-validation': ['⚙️', 'tsconfig Extends Validation'],
  'single-changed-file-resolver': ['📂', 'Single Changed-File Resolver'],
  'single-agent-filter-engine': ['🔍', 'Single Agent Filter Engine'],
});

/** No documentation TS_AST checks; export empty object for symmetry */
export const DOCUMENTATION_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({});
