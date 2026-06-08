/**
 * @fileoverview Display entries for cross-language architecture and documentation checks
 */

import type { CheckDisplayEntry } from './types.js'

/** Architecture check display entries (UNIVERSAL only) */
export const ARCHITECTURE_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'capability-by-manifest': ['🧩', 'Capability By Manifest'],
  'cli-recipe-deprecated': ['♻️', 'CLI Recipe Deprecated'],
  'command-surface-parity': ['🛡️', 'Command Surface Parity'],
  'cross-tool-flag-parity': ['🚩', 'Cross-Tool Flag Parity'],
  'docker-best-practices': ['🐳', 'Docker Best Practices'],
  'docker-ignore-validation': ['🐳', 'Docker Ignore Validation'],
  'docker-version-sync': ['🐳', 'Docker Version Sync'],
  'empty-package-detection': ['📦', 'Empty Package Detection'],
  'env-var-validation': ['🔧', 'Env Var Validation'],
  'env-via-registry': ['🌱', 'Env Via Registry'],
  'file-length-limit': ['📏', 'File Length Limit'],
  'heavy-import-detection': ['📦', 'Heavy Import Detection'],
  'interface-implementation-consistency': ['📋', 'Interface Implementation Consistency'],
  'no-custom-event-emitter': ['📨', 'No Custom Event Emitter'],
  'no-direct-stdout-in-tool-engine': ['📤', 'No Direct Stdout In Tool Engine'],
  'no-config-loader-outside-config': ['🔐', 'No Config Loader Outside Config'],
  'no-duplicate-packages': ['📦', 'No Duplicate Packages'],
  'no-local-exit-or-stdout': ['🚪', 'No Local Exit Or Stdout'],
  'no-module-singleton': ['🔒', 'No Module Singleton'],
  'node-version-consistency': ['📦', 'Node Version Consistency'],
  'one-config-document': ['📄', 'One Config Document'],
  'one-outcome-shape': ['📦', 'One Outcome Shape'],
  'project-readme-existence': ['📝', 'Project README Existence'],
  'release-gate-parity': ['🚦', 'Release Gate Parity'],
  'restrict-raw-db-access': ['🗄️', 'Restrict Raw DB Access'],
  'stale-build-artifacts': ['🏚️', 'Stale Build Artifacts'],
  'tool-has-manifest': ['🪪', 'Tool Has Manifest'],
  'vitest-config-extends-base': ['🧪', 'Vitest Config Extends Base'],
  'vitest-config-required-with-tests': ['🧪', 'Vitest Config Required With Tests'],
})

/** Documentation check display entries (UNIVERSAL only) */
export const DOCUMENTATION_DISPLAY = Object.freeze<Record<string, CheckDisplayEntry>>({
  'directive-audit': ['📝', 'Directive Audit'],
  'public-api-jsdoc': ['📝', 'Public API JSDoc Coverage'],
})
