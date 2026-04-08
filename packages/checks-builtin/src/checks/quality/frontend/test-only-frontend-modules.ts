// @fitness-ignore-file toctou-race-condition -- TOCTOU acceptable in this non-concurrent context
// @fitness-ignore-file duplicate-implementation-detection -- intentionally co-located for check isolation
/**
 * @fileoverview Test-Only Frontend Modules Check
 *
 * Detects frontend code (hooks, stores, services, utils) that is only
 * imported by test files, indicating potentially dead code.
 */

import * as path from 'node:path'

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/core'
import { isTestFile } from '../../../utils/index.js'


/**
 * Type guard to validate a Map with array values.
 * @param {unknown} value - Value to validate
 * @returns {value is Map<string, string[]>} True if value is a valid Map with array values
 */
function validateImportMap(value: unknown): value is Map<string, string[]> {
  return value instanceof Map
}

/**
 * Safe regex pattern for extracting named imports (bounded to prevent ReDoS)
 * Pattern is safe because:
 * - Uses bounded negated character class [^'"]{1,500}
 * - Has clear boundaries with quotes
 */
const NAMED_IMPORT_PATTERN = /from\s+['"]([^'"]{1,500})['"]/g

/**
 * Safe regex pattern for extracting side-effect imports (`import './foo.js'`)
 * Pattern is safe because:
 * - Uses bounded negated character class [^'"]{1,500}
 * - Has clear boundaries with quotes
 */
const SIDE_EFFECT_IMPORT_PATTERN = /^import\s+['"]([^'"]{1,500})['"]/gm

/**
 * Extract import paths from file content
 * @param content - File content
 * @returns Array of import paths
 */
// @fitness-ignore-next-line duplicate-implementation-detection -- import extraction is intentionally co-located with each check for isolation; shared utility would couple unrelated checks
function extractImportPaths(content: string): string[] {
  const paths: string[] = []

  // Match named imports: import { x } from './path'
  const namedPattern = new RegExp(NAMED_IMPORT_PATTERN.source, 'g')
  let match
  while ((match = namedPattern.exec(content)) !== null) {
    const importPath = match[1]
    if (importPath && (importPath.startsWith('.') || importPath.startsWith('@'))) {
      paths.push(importPath)
    }
  }

  // Match side-effect imports: import './path'
  const sideEffectPattern = new RegExp(SIDE_EFFECT_IMPORT_PATTERN.source, 'gm')
  while ((match = sideEffectPattern.exec(content)) !== null) {
    const importPath = match[1]
    if (importPath && (importPath.startsWith('.') || importPath.startsWith('@'))) {
      paths.push(importPath)
    }
  }

  return paths
}

/**
 * Build import map from files
 * @param files - FileAccessor for lazy file loading
 * @returns Map of import path to importer files
 */
async function buildImportMap(files: FileAccessor): Promise<Map<string, string[]>> {
  const importMap = new Map<string, string[]>()

  for (const fp of files.paths) {
    try {
      // @fitness-ignore-next-line performance-anti-patterns -- sequential file reading to control memory; FileAccessor is lazy
      const content = await files.read(fp)
      const importPaths = extractImportPaths(content)

      for (const importPath of importPaths) {
        const importers = importMap.get(importPath) ?? []
        importers.push(fp)
        importMap.set(importPath, importers)
      }
    } catch {
      // @swallow-ok Skip unreadable files
    }
  }

  return importMap
}

/**
 * Find importers for a file
 * @param filePath - File to find importers for
 * @param importMap - Map of imports (Map iteration with .entries() provides safe access)
 * @returns Array of importer file paths
 */
function findImporters(filePath: string, importMap: Map<string, string[]>): string[] {
  // Map parameter validation: iteration via .entries() handles undefined/null safely
  if (!validateImportMap(importMap)) {
    return []
  }
  // Validate Map size before iteration
  if (importMap.size === 0) {
    return []
  }

  const basename = path.basename(filePath, path.extname(filePath))
  const dirname = path.dirname(filePath)
  const parentDir = path.basename(dirname)
  const importers: string[] = []

  for (const [importPath, importerFiles] of importMap.entries()) {
    const matchesBasename =
      importPath.includes(basename) || importPath.includes(`${parentDir}/${basename}`)
    const hasValidImporters = Array.isArray(importerFiles) && importerFiles.length > 0

    if (matchesBasename && hasValidImporters) {
      importers.push(...importerFiles)
    }
  }

  return importers
}

/**
 * Check: quality/test-only-frontend-modules
 *
 * Detects frontend code only imported by test files.
 */
export const testOnlyFrontendModules = defineCheck({
  id: '78a085b3-55c4-42d3-a74c-8dfaad8123f1',
  slug: 'test-only-frontend-modules',
  scope: { languages: ['typescript', 'tsx'], concerns: ['frontend', 'ui'] },
  contentFilter: 'code-only',
  confidence: 'medium',
  description: 'Detects frontend code only imported by test files',
  tags: ['quality', 'code-quality', 'maintainability'],
  fileTypes: ['ts', 'tsx'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = []

    // Build import map
    const importMap = await buildImportMap(files)

    // Check each file to see if it's only imported by tests
    for (const filePath of files.paths) {
      // Skip files in test directories — they are test utilities by design
      if (isTestFile(filePath)) {
        continue
      }

      const importers = findImporters(filePath, importMap)

      if (importers.length === 0) {
        continue
      }

      const productionImporters = importers.filter((f) => !isTestFile(f))
      const testImporters = importers.filter((f) => isTestFile(f))

      if (productionImporters.length === 0 && testImporters.length > 0) {
        violations.push({
          filePath,
          line: 1,
          column: 0,
          message: `Only imported by test files (${testImporters.length} test imports, 0 production)`,
          severity: 'error',
          suggestion:
            'This module is only used in tests. Either add production usage, move it to a test utilities folder, or delete it if no longer needed',
          match: path.basename(filePath),
        })
      }
    }

    return violations
  },
})
