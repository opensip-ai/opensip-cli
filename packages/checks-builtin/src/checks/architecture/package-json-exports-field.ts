/**
 * @fileoverview Package.json exports field validation
 * @module checks-builtin/checks/architecture/package-json-exports-field
 *
 * Ensures packages have an "exports" field in package.json for explicit
 * ESM module resolution. Without it, consumers can import from any path
 * inside the package, creating fragile coupling to internal structure.
 */

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/core'

export const packageJsonExportsField = defineCheck({
  id: 'e1f2a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b',
  slug: 'package-json-exports-field',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },
  confidence: 'high',
  description: 'Ensures packages have an "exports" field in package.json for explicit module resolution',
  tags: ['architecture', 'esm', 'monorepo'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = []
    const packageJsonPaths = files.paths.filter(p =>
      p.endsWith('package.json') &&
      !p.includes('node_modules') &&
      p !== 'package.json' && // skip root
      (p.startsWith('packages/') || p.startsWith('services/')),
    )

    for (const filePath of packageJsonPaths) {
      const content = await files.read(filePath)
      if (!content) continue

      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(content) as Record<string, unknown>
      } catch {
        continue
      }

      // Skip private packages that aren't consumed by others
      if (parsed.private === true && !filePath.startsWith('packages/')) continue

      if (!parsed.exports) {
        const name = (parsed.name as string) ?? filePath
        violations.push({
          filePath,
          line: 1,
          message: `Package "${name}" has no "exports" field. Consumers can import from any internal path, creating fragile coupling.`,
          severity: 'warning',
          suggestion: 'Add an "exports" field to explicitly define public entry points. Example: "exports": { ".": "./dist/index.js" }',
          type: 'MISSING_EXPORTS_FIELD',
        })
      }
    }

    return violations
  },
})
