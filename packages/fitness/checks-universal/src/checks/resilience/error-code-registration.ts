/**
 * @fileoverview Error code registration check
 */

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness';

/**
 * Check: resilience/error-code-registration
 *
 * Validates that error codes used in code are registered in
 * an error registry file (error-codes.ts, errors.ts, etc.)
 */
export const errorCodeRegistration = defineCheck({
  id: '346b53d8-58a3-4fd5-8340-d7bd42da406a',
  slug: 'error-code-registration',
  disabled: true,
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Validates that error codes used in code are registered in an error registry file',
  longDescription: `**Purpose:** Ensures all error codes used in the codebase are registered in a central error registry file, enabling error catalogs, monitoring, and consistent conventions.

**Detects:**
- Error codes (DOMAIN.CATEGORY.SPECIFIC format) used in \`code:\` or \`errorCode:\` properties that are not defined in any error-codes.ts, errors.ts, or error-registry.ts file

**Why it matters:** Unregistered error codes make centralized error catalogs incomplete, complicate monitoring, and lead to ad-hoc codes that don't follow conventions.

**Scope:** Backend code. Analyzes all matched files together (\`analyzeAll\`) to correlate error code usage with registry definitions.`,
  tags: ['errors', 'resilience', 'consistency'],
  fileTypes: ['ts'],

  // eslint-disable-next-line sonarjs/cognitive-complexity -- Inherent complexity: two-phase analysis collecting registered codes from registry files, then scanning all files for unregistered usage
  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = [];

    // Phase 1: Collect all registered error codes from registry files
    const registeredCodes = new Set<string>();
    const registryFilePattern = /(?:error-codes|error-registry|errors)\.ts$/;

    const registryPaths = files.paths.filter((fp) => registryFilePattern.test(fp));
    // @fitness-ignore-next-line no-unbounded-concurrency -- bounded by small number of error registry files (typically 1-3)
    const registryContents = await Promise.all(registryPaths.map((fp) => files.read(fp)));

    for (const content of registryContents) {
      if (!content) continue;

      // Match code definitions: 'DOMAIN.CATEGORY.SPECIFIC' in any context
      const codeRegex = /['"]([A-Z][A-Z0-9]*(?:\.[A-Z][A-Z0-9_]*){2,})['"]/g;
      let match;
      while ((match = codeRegex.exec(content)) !== null) {
        if (match[1]) registeredCodes.add(match[1]);
      }
    }

    // Phase 2: Scan non-registry files for error code usage
    const nonRegistryPaths = files.paths.filter((fp) => !registryFilePattern.test(fp));
    // @fitness-ignore-next-line no-unbounded-concurrency -- bounded by files matching target; read is lightweight (FileAccessor caches)
    const nonRegistryContents = await Promise.all(nonRegistryPaths.map((fp) => files.read(fp)));

    for (const [fileIdx, filePath] of nonRegistryPaths.entries()) {
      if (!filePath) continue;
      const content = nonRegistryContents[fileIdx];
      if (!content) continue;
      const lines = content.split('\n');

      for (const [i, line_] of lines.entries()) {
        const line = line_ ?? '';
        const trimmed = line.trim();

        // Skip comments
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

        // Match: code: 'DOMAIN.CATEGORY.SPECIFIC' or errorCode: 'DOMAIN.CATEGORY.SPECIFIC'
        const codeUsageRegex =
          /(?:code|errorCode)\s*:\s*['"]([A-Z][A-Z0-9]*(?:\.[A-Z][A-Z0-9_]*){2,})['"]/g;
        let usageMatch;
        while ((usageMatch = codeUsageRegex.exec(line)) !== null) {
          const code = usageMatch[1];
          if (code && !registeredCodes.has(code)) {
            violations.push({
              filePath,
              line: i + 1,
              message: `Error code '${code}' is used but not registered in any error registry file`,
              severity: 'warning',
              suggestion: `Register '${code}' in the appropriate error-codes.ts or error-registry.ts file`,
              type: 'unregistered-error-code',
              match: trimmed.slice(0, 120),
            });
          }
        }
      }
    }

    return violations;
  },
});
