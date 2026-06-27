/**
 * @fileoverview TSConfig extends validation
 * @module checks-builtin/checks/architecture/tsconfig-extends-validation
 *
 * Ensures all tsconfig.json files extend a shared base configuration
 * and that the referenced base file exists. Prevents config drift
 * across packages in a monorepo.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-cli/fitness';

export const tsconfigExtendsValidation = defineCheck({
  id: '842e7d00-c8e8-4a57-873a-c03caec7e603',
  slug: 'tsconfig-extends-validation',
  scope: {
    languages: ['typescript'],
    concerns: ['backend', 'frontend', 'cli'],
  },
  confidence: 'high',
  description: 'Ensures all tsconfig.json files extend a shared base and the base file exists',
  tags: ['architecture', 'typescript', 'monorepo'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = [];
    const tsconfigPaths = files.paths.filter(
      (p) => p.endsWith('tsconfig.json') && !p.includes('node_modules'),
    );

    for (const filePath of tsconfigPaths) {
      const content = await files.read(filePath);
      /* v8 ignore next -- defensive guard */
      if (!content) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(content) as Record<string, unknown>;
      } catch {
        violations.push({
          filePath,
          line: 1,
          message: 'Invalid JSON in tsconfig.json',
          severity: 'error',
          type: 'TSCONFIG_INVALID_JSON',
        });
        continue;
      }

      // Root tsconfig doesn't need to extend
      if (
        filePath === 'tsconfig.json' ||
        (filePath.endsWith('/tsconfig.json') && filePath.split('/').length === 2)
      ) {
        continue;
      }

      const extendsValue = parsed.extends;
      if (!extendsValue || typeof extendsValue !== 'string') {
        violations.push({
          filePath,
          line: 1,
          message:
            'tsconfig.json does not extend a base configuration. Add "extends" to ensure consistent compiler options.',
          severity: 'warning',
          suggestion:
            'Add "extends": "../../tsconfig.json" (or appropriate relative path to the root tsconfig).',
          type: 'TSCONFIG_NO_EXTENDS',
        });
        continue;
      }

      // Verify the extended file exists
      const dir = dirname(filePath);
      const resolvedBase = resolve(process.cwd(), dir, extendsValue);
      const baseWithJson = resolvedBase.endsWith('.json') ? resolvedBase : `${resolvedBase}.json`;

      if (!existsSync(resolvedBase) && !existsSync(baseWithJson)) {
        violations.push({
          filePath,
          line: 1,
          message: `tsconfig.json extends "${extendsValue}" but the file does not exist at ${resolvedBase}`,
          severity: 'error',
          suggestion: 'Fix the "extends" path or create the missing base tsconfig.',
          type: 'TSCONFIG_MISSING_BASE',
        });
      }
    }

    return violations;
  },
});
