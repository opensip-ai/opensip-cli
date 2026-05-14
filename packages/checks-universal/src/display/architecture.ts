/**
 * @fileoverview Display entries for cross-language architecture and documentation checks
 */

import type { CheckDisplayEntry } from './types.js'

/** Architecture check display entries (UNIVERSAL only) */
export const ARCHITECTURE_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'docker-best-practices': ['🐳', 'Docker Best Practices'],
  'docker-ignore-validation': ['🐳', 'Docker Ignore Validation'],
  'docker-version-sync': ['🐳', 'Docker Version Sync'],
  'empty-package-detection': ['📦', 'Empty Package Detection'],
  'env-var-validation': ['🔧', 'Env Var Validation'],
  'interface-implementation-consistency': ['📋', 'Interface Implementation Consistency'],
  'no-custom-event-emitter': ['📨', 'No Custom Event Emitter'],
  'no-duplicate-packages': ['📦', 'No Duplicate Packages'],
  'node-version-consistency': ['📦', 'Node Version Consistency'],
  'phantom-dependency-detection': ['📦', 'Phantom Dependency Detection'],
  'project-readme-existence': ['📝', 'Project README Existence'],
})

/** Documentation check display entries (UNIVERSAL only) */
export const DOCUMENTATION_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'directive-audit': ['📝', 'Directive Audit'],
  'public-api-jsdoc': ['📝', 'Public API JSDoc Coverage'],
})
