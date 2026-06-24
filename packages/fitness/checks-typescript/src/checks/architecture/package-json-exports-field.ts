/**
 * @fileoverview Package.json exports field validation
 * @module checks-builtin/checks/architecture/package-json-exports-field
 *
 * Ensures packages have an "exports" field in package.json for explicit
 * ESM module resolution. Without it, consumers can import from any path
 * inside the package, creating fragile coupling to internal structure.
 */

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-cli/fitness';

// Match a `packages/` or `services/` workspace segment whether the path is
// repo-relative (`packages/a/package.json`) or absolute (`/abs/packages/a/…`).
const WORKSPACE_SEGMENT = /(?:^|\/)(?:packages|services)\//;
const PACKAGES_SEGMENT = /(?:^|\/)packages\//;

export const packageJsonExportsField = defineCheck({
  id: 'b4203be3-3308-4fb1-8b20-44e23b8e3eff',
  slug: 'package-json-exports-field',
  contentFilter: 'strip-strings',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  confidence: 'high',
  description:
    'Ensures packages have an "exports" field in package.json for explicit module resolution',
  tags: ['architecture', 'esm', 'monorepo'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = [];
    const packageJsonPaths = files.paths.filter(
      (p) => p.endsWith('package.json') && !p.includes('node_modules') && WORKSPACE_SEGMENT.test(p), // only workspace packages/services (excludes the root)
    );

    for (const filePath of packageJsonPaths) {
      const content = await files.read(filePath);
      /* v8 ignore next -- defensive guard */
      if (!content) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(content) as Record<string, unknown>;
        /* v8 ignore next 1 -- defensive catch: parse failures already handled */
      } catch {
        continue;
      }

      // Skip private packages that aren't consumed by others
      if (parsed.private === true && !PACKAGES_SEGMENT.test(filePath)) continue;

      if (!parsed.exports) {
        const name = (parsed.name as string) ?? filePath;
        violations.push({
          filePath,
          line: 1,
          message: `Package "${name}" has no "exports" field. Consumers can import from any internal path, creating fragile coupling.`,
          severity: 'warning',
          suggestion:
            'Add an "exports" field to explicitly define public entry points. Example: "exports": { ".": "./dist/index.js" }',
          type: 'MISSING_EXPORTS_FIELD',
        });
      }
    }

    return violations;
  },
});
