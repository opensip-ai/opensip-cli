/**
 * @fileoverview Missing type exports detection
 * @module checks-builtin/checks/architecture/missing-type-exports
 *
 * Detects types imported via deep internal paths but not exported
 * from the package barrel (index.ts). This creates fragile coupling
 * to internal package structure.
 */

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/core'

const IMPORT_PATTERN = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g
const EXPORT_PATTERN = /export\s+(?:type\s+)?\{([^}]+)\}/g
const EXPORT_NAMED_PATTERN = /export\s+(?:type\s+)?(?:interface|type|class|enum|function|const)\s+(\w+)/g
const RE_EXPORT_PATTERN = /export\s+(?:type\s+)?\*\s+from\s+['"]([^'"]+)['"]/g

function extractNames(block: string): string[] {
  return block.split(',').map(n => {
    const trimmed = n.trim()
    const asMatch = trimmed.match(/^(\w+)\s+as\s+/)
    return asMatch ? asMatch[1] : trimmed
  }).filter(n => n.length > 0 && /^\w+$/.test(n))
}

export const missingTypeExports = defineCheck({
  id: 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
  slug: 'missing-type-exports',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend'] },
  confidence: 'medium',
  description: 'Detects types imported via deep internal paths but not exported from the package barrel',
  tags: ['architecture', 'api-surface', 'monorepo'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = []

    // Build set of exported names from barrel files
    const barrelFiles = files.paths.filter(p =>
      (p.match(/^packages\/[^/]+\/src\/index\.ts$/) !== null ||
       p.match(/^services\/[^/]+\/src\/index\.ts$/) !== null) &&
      !p.includes('node_modules'),
    )

    const allExportedNames = new Set<string>()

    for (const barrelPath of barrelFiles) {
      const content = await files.read(barrelPath)
      if (!content) continue

      let match: RegExpExecArray | null

      EXPORT_PATTERN.lastIndex = 0
      while ((match = EXPORT_PATTERN.exec(content)) !== null) {
        for (const name of extractNames(match[1])) allExportedNames.add(name)
      }

      EXPORT_NAMED_PATTERN.lastIndex = 0
      while ((match = EXPORT_NAMED_PATTERN.exec(content)) !== null) {
        if (match[1]) allExportedNames.add(match[1])
      }
    }

    // Scan for deep internal imports
    for (const filePath of files.paths) {
      if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) continue
      if (filePath.includes('node_modules') || filePath.includes('/dist/')) continue
      if (filePath.includes('.test.') || filePath.includes('__tests__')) continue

      const content = await files.read(filePath)
      if (!content) continue

      IMPORT_PATTERN.lastIndex = 0
      let importMatch: RegExpExecArray | null
      while ((importMatch = IMPORT_PATTERN.exec(content)) !== null) {
        const importPath = importMatch[2]
        if (!importPath.startsWith('@') || !importPath.includes('/')) continue

        const segments = importPath.split('/')
        if (segments.length < 3) continue

        const names = extractNames(importMatch[1])
        for (const name of names) {
          if (!allExportedNames.has(name)) {
            const lineNum = content.slice(0, importMatch.index).split('\n').length
            violations.push({
              filePath,
              line: lineNum,
              message: `'${name}' imported from deep path '${importPath}' but not found in any package barrel export.`,
              severity: 'warning',
              suggestion: `Export '${name}' from the package's index.ts, then import from the package root.`,
              type: 'MISSING_TYPE_EXPORT',
              match: name,
            })
          }
        }
      }
    }

    return violations
  },
})
