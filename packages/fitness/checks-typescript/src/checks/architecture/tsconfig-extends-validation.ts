/**
 * @fileoverview TSConfig extends validation
 * @module checks-builtin/checks/architecture/tsconfig-extends-validation
 *
 * Ensures all tsconfig.json files extend a shared base configuration
 * and that the referenced base file exists. Prevents config drift
 * across packages in a monorepo.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-cli/fitness';

/** True when `extends` is a package-style reference (not a relative/absolute path). */
function isPackageStyleExtends(value: string): boolean {
  // Relative (./ ../) or absolute (/ C:\ …) paths are local filesystem targets.
  if (value.startsWith('./') || value.startsWith('../')) return false;
  if (isAbsolute(value)) return false;
  return true;
}

/** Normalize `extends` to a string list (TS 5+ allows string | string[]). */
function normalizeExtends(extendsValue: unknown): string[] | null {
  if (typeof extendsValue === 'string' && extendsValue.length > 0) return [extendsValue];
  if (Array.isArray(extendsValue)) {
    const values = extendsValue.filter((v): v is string => typeof v === 'string' && v.length > 0);
    return values.length > 0 ? values : null;
  }
  return null;
}

/**
 * True when a package-style extends can be resolved via Node module resolution,
 * or when we intentionally skip existence (resolution unavailable). Relative
 * paths are checked on the filesystem.
 */
function baseExists(filePath: string, extendsValue: string): boolean {
  if (isPackageStyleExtends(extendsValue)) {
    // Package-style extends (e.g. "@tsconfig/node20/tsconfig.json") are not
    // local relative files — resolve via require.resolve from the tsconfig's
    // directory (or skip if Node cannot resolve). Never treat as a missing
    // local relative path.
    try {
      const from = resolve(process.cwd(), filePath);
      const req = createRequire(from);
      req.resolve(extendsValue);
      return true;
    } catch {
      try {
        const from = resolve(process.cwd(), filePath);
        const req = createRequire(from);
        req.resolve(extendsValue.endsWith('.json') ? extendsValue : `${extendsValue}.json`);
        return true;
      } catch {
        // Unresolvable package refs are not "missing local files" — skip.
        return true;
      }
    }
  }

  const dir = dirname(filePath);
  const resolvedBase = resolve(process.cwd(), dir, extendsValue);
  const baseWithJson = resolvedBase.endsWith('.json') ? resolvedBase : `${resolvedBase}.json`;
  return existsSync(resolvedBase) || existsSync(baseWithJson);
}

export const tsconfigExtendsValidation = defineCheck({
  id: '4a62d660-9d44-4877-94f8-2c4dc7f3aa40',
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

      const extendsList = normalizeExtends(parsed.extends);
      if (!extendsList) {
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

      for (const extendsValue of extendsList) {
        if (baseExists(filePath, extendsValue)) continue;

        const dir = dirname(filePath);
        const resolvedBase = resolve(process.cwd(), dir, extendsValue);
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
