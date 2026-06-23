// @fitness-ignore-file throws-documentation -- Functions throw self-documenting typed errors
// @fitness-ignore-file toctou-race-condition -- local nested Map `functionsByName`; synchronous get-then-set that lazily creates a per-name group, no await between read and write
/**
 * @fileoverview Duplicate Utility Functions check
 *
 * Detects duplicate utility functions that should be consolidated.
 * Flags TWO types of issues:
 * 1. Identical implementations - true duplicates that must be deduplicated
 * 2. Same-named functions with different implementations - consolidation opportunities
 */

import { defineCheck, type CheckViolation } from '@opensip-cli/fitness';

import {
  buildEffectiveDomainSpecificSet,
  collectFunctionsFromFiles,
  processFunctionGroup,
} from './duplicate-utility-functions-helpers.js';

export {
  DOMAIN_SPECIFIC_FUNCTION_NAMES,
  type DuplicateUtilityFunctionsConfig,
} from './duplicate-utility-functions-config.js';

/**
 * Check: quality/duplicate-utility-functions
 *
 * Detects utility functions that should be consolidated across the codebase.
 * Reports two types of issues:
 * - IDENTICAL: Same name, same implementation (true duplicates)
 * - SIMILAR: Same name, different implementation (consolidation opportunities)
 */
export const duplicateUtilityFunctions = defineCheck({
  id: 'aa303a1e-f3f8-4a11-ade2-9e29af89c299',
  slug: 'duplicate-utility-functions',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detect duplicate and similar utility functions',
  longDescription: `**Purpose:** Detects utility functions that are duplicated or similarly named across the codebase, flagging consolidation opportunities into shared packages.

**Detects:** Cross-file analysis using TypeScript AST extraction and SHA-256 body hashing.
- **Identical duplicates:** Same-named utility functions with identical normalized bodies in different directories
- **Similar implementations:** Same-named utility functions with different bodies across directories (consolidation with options pattern)
- Targets functions matching utility name patterns: \`format*\`, \`parse*\`, \`is*\`, \`has*\`, \`to*\`, \`get*\`, \`validate*\`, \`sanitize*\`, \`normalize*\`, \`debounce\`, \`throttle\`, \`sleep\`, \`retry\`, etc.
- Skips domain-specific functions listed in \`DOMAIN_SPECIFIC_FUNCTIONS\` and bodies under 50 characters

**Why it matters:** Duplicated utilities create maintenance risk and inconsistent behavior. A single shared implementation in \`foundation/utils\` ensures consistent behavior and reduces code volume.

**Scope:** General best practice`,
  tags: ['quality', 'dry', 'utilities', 'duplication'],
  fileTypes: ['ts'],

  async analyzeAll(files): Promise<CheckViolation[]> {
    const domainSpecific = buildEffectiveDomainSpecificSet();
    const functionsByName = await collectFunctionsFromFiles(files, domainSpecific);
    const violations: CheckViolation[] = [];

    for (const [name, hashGroups] of functionsByName) {
      // @fitness-ignore-next-line performance-anti-patterns -- spread aggregates small violation arrays from pure function
      violations.push(...processFunctionGroup(name, hashGroups));
    }

    return violations;
  },
});
