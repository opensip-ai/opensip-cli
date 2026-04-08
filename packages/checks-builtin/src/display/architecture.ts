/**
 * @fileoverview Display entries for architecture and documentation checks
 */

import type { CheckDisplayEntry } from './types.js'

/** Architecture check display entries */
export const ARCHITECTURE_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'contracts-schema-consistency': ['\uD83D\uDCCB', 'Contracts Schema Consistency'],
  'di-static-inject-usage': ['\uD83D\uDC89', 'DI Static Inject Usage'],
  'docker-best-practices': ['\uD83D\uDC33', 'Docker Best Practices'],
  'docker-ignore-validation': ['\uD83D\uDC33', 'Docker Ignore Validation'],
  'docker-version-sync': ['\uD83D\uDC33', 'Docker Version Sync'],
  'empty-package-detection': ['\uD83D\uDCE6', 'Empty Package Detection'],
  'env-var-validation': ['\uD83D\uDD27', 'Env Var Validation'],
  'interface-implementation-consistency': ['\uD83D\uDCCB', 'Interface Implementation Consistency'],
  'no-custom-event-emitter': ['\uD83D\uDCE8', 'No Custom Event Emitter'],
  'no-duplicate-packages': ['\uD83D\uDCE6', 'No Duplicate Packages'],
  'node-version-consistency': ['\uD83D\uDCE6', 'Node Version Consistency'],
  'phantom-dependency-detection': ['\uD83D\uDCE6', 'Phantom Dependency Detection'],
  'project-readme-existence': ['\uD83D\uDCDD', 'Project README Existence'],
  'typed-inject-scope-mismatch': ['\uD83D\uDC89', 'Typed-Inject Scope Mismatch'],
  'unused-modules': ['\uD83E\uDDF9', 'Unused Modules'],
})

/** Documentation check display entries */
export const DOCUMENTATION_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'directive-audit': ['\uD83D\uDCDD', 'Directive Audit'],
  'public-api-jsdoc': ['\uD83D\uDCDD', 'Public API JSDoc Coverage'],
})
