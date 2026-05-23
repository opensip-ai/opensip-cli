// @fitness-ignore-file toctou-race-condition -- TOCTOU acceptable in this non-concurrent context
// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
/**
 * @fileoverview Test-Only Implementations Check
 *
 * Detects production code that is only imported by test files, indicating
 * potentially dead code or implementations that should be removed.
 */

import * as path from 'node:path'

import { ValidationError } from '@opensip-tools/core'
import { defineCheck, isTestFile, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness'

/**
 * Check if a file is an implementation file.
 */
function isImplementationFile(filePath: string): boolean {
  return (
    filePath.includes('/implementations/') ||
    filePath.includes('/adapters/') ||
    filePath.includes('/repositories/') ||
    filePath.includes('/providers/')
  )
}

/**
 * Extract import paths from file content using string operations.
 */
function extractRelativeImports(content: string): string[] {
  const imports: string[] = []
  const lines = content.split('\n')

  for (const line of lines) {
    const importPath = extractImportFromLine(line)
    if (importPath?.startsWith('.')) {
      imports.push(importPath)
    }
  }

  return imports
}

/**
 * Extract the import path from a single line.
 */
function extractImportFromLine(line: string): string | null {
  const fromIdx = line.indexOf('from ')
  if (fromIdx === -1) {
    return null
  }

  const afterFrom = line.slice(fromIdx + 5).trimStart()
  const quoteChar = afterFrom[0]
  if (quoteChar !== "'" && quoteChar !== '"') {
    return null
  }

  const endQuoteIdx = afterFrom.indexOf(quoteChar, 1)
  if (endQuoteIdx === -1) {
    return null
  }

  return afterFrom.slice(1, endQuoteIdx)
}

/**
 * Build a map of import paths to their importer files.
 */
async function buildImportMap(files: FileAccessor): Promise<Map<string, string[]>> {
  const importMap = new Map<string, string[]>()

  for (const fp of files.paths) {
    try {
      // @fitness-ignore-next-line performance-anti-patterns -- sequential file reading to control memory; FileAccessor is lazy
      const content = await files.read(fp)
      const imports = extractRelativeImports(content)

      for (const importPath of imports) {
        /* v8 ignore next -- defensive nullish fallback */
        const importers = importMap.get(importPath) ?? []
        importers.push(fp)
        importMap.set(importPath, importers)
      }
    /* v8 ignore next 1 -- defensive catch: parse failures already handled */
    } catch {
      // @swallow-ok Skip unreadable files
    }
  }

  return importMap
}

/**
 * Find all files that import a given implementation file.
 */
function findImporters(
  basename: string,
  parentDir: string,
  importMap: Map<string, string[]>,
): string[] {
  if (!(importMap instanceof Map)) {
    // @fitness-ignore-next-line result-pattern-consistency -- internal method, exceptions propagate to public Result boundary
    throw new ValidationError('importMap must be a Map', {
      code: 'FITNESS.CHECK.INVALID_IMPORT_MAP',
      metadata: { received: typeof importMap },
    })
  }
  const importers: string[] = []

  for (const [importPath, importerFiles] of importMap.entries()) {
    const matchesBasename = importPath.includes(basename)
    const matchesFullPath = importPath.includes(`${parentDir}/${basename}`)
    if (matchesBasename || matchesFullPath) {
      importers.push(...importerFiles)
    }
  }

  return importers
}

/**
 * Check: quality/test-only-implementations
 *
 * Detects production code only imported by test files.
 */
export const testOnlyImplementations = defineCheck({
  id: '3a296114-cf87-48f0-bef5-16197a7941c8',
  slug: 'test-only-implementations',
  scope: { languages: ['typescript', 'tsx'], concerns: ['testing'] },

  confidence: 'medium',
  description: 'Detects production code only imported by test files',
  tags: ['quality', 'code-quality', 'maintainability'],
  fileTypes: ['ts'],
  disabled: true, // Disabled: references old /implementations/, /adapters/, /repositories/, /providers/ structure not present in opensip
  // @fitness-ignore-next-line no-hardcoded-timeouts -- framework default for fitness check execution
  timeout: 180_000, // 3 minutes - analyzes import graphs

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = []

    const implFiles = files.paths.filter(isImplementationFile)
    const importMap = await buildImportMap(files)

    for (const filePath of implFiles) {
      const basename = path.basename(filePath, '.ts')
      const dirname = path.dirname(filePath)
      const parentDir = path.basename(dirname)

      const importers = findImporters(basename, parentDir, importMap)
      if (importers.length === 0) continue

      const productionImporters = importers.filter((f) => !isTestFile(f))
      const testImporters = importers.filter((f) => isTestFile(f))

      if (productionImporters.length === 0 && testImporters.length > 0) {
        violations.push({
          line: 1,
          column: 0,
          message: `Only imported by test files (${testImporters.length} test imports, 0 production)`,
          severity: 'error',
          suggestion:
            'This implementation is only used in tests. Either wire it into production code, move it to testing/ folder, or delete it if obsolete',
          match: path.basename(filePath),
          filePath,
        })
      }
    }

    return violations
  },
})
