/**
 * @fileoverview Null/Undefined Safety Check
 *
 * Detects unsafe property and method access without null checks.
 */

import {
  defineCheck,
  getCheckConfig,
  isTestFile,
  type CheckViolation,
  type FileAccessor,
} from '@opensip-cli/fitness';

import { getSharedTypeCheckedProgram } from '../../../shared/type-program.js';

import { analyzeFileConvention, analyzeFileTyped } from './null-safety-analyze.js';
import { type NullSafetyConfig } from './null-safety-config.js';

export { analyzeNullSafety, analyzeNullSafetyTyped } from './null-safety-analyze.js';
export { SAFE_BUILDER_PREFIXES, SAFE_METHOD_PREFIXES } from './null-safety-config.js';

/**
 * Check: quality/null-safety
 *
 * Detects unsafe property and method access without null checks.
 */
export const nullSafety = defineCheck({
  id: '011c993e-829b-4423-8032-0b7c9baa22bf',
  slug: 'null-safety',
  scope: {
    languages: ['typescript'],
    concerns: ['backend', 'frontend', 'cli'],
  },
  contentFilter: 'strip-strings',

  confidence: 'high',
  description: 'Detect unsafe property and method access without null checks',
  longDescription: `**Purpose:** Detects property access on potentially nullable expressions (call results, element access) that lack null/undefined guards, preventing runtime \`TypeError\` crashes.

**Mode (\`typeAware\`, default \`true\`):** Type-aware — flags a property access on a call/element-access result only when the receiver's ACTUAL type includes \`null\`/\`undefined\`. The checker handles control-flow guards, optional chaining (\`?.\`), builder/Zod/TypeORM return types, and chain depth; \`any\`/\`unknown\`/unresolved types are never flagged (fail-open). \`additionalSafeBuilders\` is a manual escape hatch. Set \`typeAware: false\` for the legacy name/convention heuristic (higher false-negative rate).

**Always skipped:** safe property names (\`length\`, \`toString\`, \`valueOf\`) and \`additionalSafeNullPaths\` (schema/DI) files.

**Why it matters:** Accessing a property on a \`null\` or \`undefined\` value causes runtime \`TypeError\` exceptions that crash the process if uncaught.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['quality', 'code-quality', 'type-safety'],
  fileTypes: ['ts', 'tsx'],

  // D2: runs as analyzeAll so a single type-checked ts.Program can be shared
  // across the run. `typeAware` (recipe config, default off) selects the
  // type-aware detector; otherwise the convention-based detector runs unchanged,
  // so default behavior is byte-identical to the prior per-file `analyze` mode.
  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    // Type-aware is the DEFAULT (D2): flag a property access only when the
    // receiver's actual type is nullable. Set `typeAware: false` in recipe config
    // to fall back to the legacy name/convention heuristic.
    const typeAware = getCheckConfig<NullSafetyConfig>('null-safety').typeAware !== false;
    // Build the shared type-checked Program only in type-aware mode (~1s/~0.6GB,
    // amortized across type-aware checks). The convention fallback needs no Program.
    const program = typeAware ? getSharedTypeCheckedProgram(files.paths) : undefined;

    const violations: CheckViolation[] = [];
    for (const filePath of files.paths) {
      // Skip test files — null safety in tests is low-risk due to controlled inputs.
      if (isTestFile(filePath)) continue;
      const fileViolations = program
        ? analyzeFileTyped(program, filePath)
        : await analyzeFileConvention(files, filePath);
      for (const violation of fileViolations) {
        // analyzeAll injects no default filePath (analyze mode did) — stamp it.
        violations.push(violation.filePath ? violation : { ...violation, filePath });
      }
    }
    return violations;
  },
});
