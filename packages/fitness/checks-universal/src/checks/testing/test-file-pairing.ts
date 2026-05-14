/**
 * @fileoverview Ensures every source file in services has a corresponding test file
 *
 * This check validates that source files have matching test files.
 * Supports @test-pending marker for files awaiting test implementation.
 */

// @fitness-ignore-file fitness-check-standards -- Uses fs for directory listing/stat/existsSync operations, not file content reading
import * as fs from 'node:fs'
import * as path from 'node:path'

import { logger } from '@opensip-tools/core/logger'
import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness'

/**
 * Directories to skip during scanning
 */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '__tests__',
  'tests',
  'types',
  'interfaces',
  'config',
  'checks', // Fitness check definition files are declarative — tested via fitness-check-coverage
])

/**
 * Check if entry should be skipped
 * @param {string} entry - The directory or file entry name to check
 * @returns {boolean} True if the entry should be skipped, false otherwise
 */
function shouldSkipEntry(entry: string): boolean {
  logger.debug({
    evt: 'fitness.checks.test_file_pairing.should_skip_entry',
    msg: 'Checking if entry should be skipped',
  })
  return entry.startsWith('.') || SKIP_DIRECTORIES.has(entry)
}

/**
 * Config files that don't need tests
 */
const CONFIG_FILE_PATTERNS = [
  /^vitest\.(config|setup|workspace)\.ts$/,
  /^jest\.(config|setup)\.ts$/,
  /^eslint\.config\.ts$/,
  /^prettier\.config\.ts$/,
  /^tailwind\.config\.ts$/,
  /^tsconfig\..+\.ts$/,
  /\.config\.ts$/,
  /\.setup\.ts$/,
]

/**
 * Check if file is a source file that needs tests
 * @param {string} filename - The filename to check
 * @param {string} [relativePath] - Optional relative path for additional context
 * @returns {boolean} True if the file is a source file that needs tests, false otherwise
 */
function isSourceFile(filename: string, relativePath?: string): boolean {
  logger.debug({
    evt: 'fitness.checks.test_file_pairing.is_source_file',
    msg: 'Checking if file is a source file that needs tests',
  })
  // Must be TS
  if (!filename.endsWith('.ts') && !filename.endsWith('.tsx')) return false
  // Skip declarations
  if (filename.endsWith('.d.ts')) return false
  // Skip existing test files
  if (filename.includes('.test.') || filename.includes('.spec.')) return false
  // Skip index files (often just exports)
  if (filename === 'index.ts') return false
  // Skip config files (vitest.config.ts, vitest.setup.ts, etc.)
  if (CONFIG_FILE_PATTERNS.some((pattern) => pattern.test(filename))) return false
  // Skip interface files (pure type definitions)
  if (filename.includes('.interface.ts') || filename.includes('.interface.tsx')) return false
  // Skip type definition files and data-only files
  const typeOnlyPatterns = ['-types.ts', '-interfaces.ts', 'errors.ts', 'enums.ts', 'logger.ts']
  if (typeOnlyPatterns.some((pattern) => filename.endsWith(pattern))) return false
  // Skip exact 'types.ts' (barrel type exports)
  if (filename === 'types.ts' || filename === 'types.tsx') return false
  // Skip pure data/schema/constants files
  const dataOnlyPatterns = ['schema.ts', 'constants.ts', 'profiles.ts', 'error-messages.ts']
  if (dataOnlyPatterns.includes(filename)) return false
  // Skip files in types/ or interfaces/ directories
  if (relativePath && (relativePath.includes('/types/') || relativePath.includes('/interfaces/')))
    return false
  // Skip fitness check definition directories (declarative defineCheck files)
  if (relativePath && relativePath.includes('/fitness/src/checks/') && !relativePath.includes('__tests__'))
    return false
  return true
}

/**
 * Check if a file has a test pair
 * @param {string} dir - The directory containing the file
 * @param {string} filename - The filename to check for test pairing
 * @returns {boolean} True if a test pair exists, false otherwise
 */
function hasTestPair(dir: string, filename: string): boolean {
  logger.debug({
    evt: 'fitness.checks.test_file_pairing.has_test_pair',
    msg: 'Checking if file has a test pair',
  })
  // @fitness-ignore-next-line null-safety -- path.parse() always returns a valid ParsedPath object with a name property
  const name = path.parse(filename).name
  const parentDir = path.dirname(dir)

  const possibilities = [
    // Adjacent test files
    path.join(dir, `${name}.test.ts`),
    path.join(dir, `${name}.spec.ts`),
    path.join(dir, `${name}.test.tsx`),
    path.join(dir, `${name}.spec.tsx`),
    // __tests__ directory (flat)
    path.join(dir, '__tests__', `${name}.test.ts`),
    path.join(dir, '__tests__', `${name}.spec.ts`),
    path.join(dir, '__tests__', `${name}.test.tsx`),
    path.join(dir, '__tests__', `${name}.spec.tsx`),
    // __tests__/unit directory
    path.join(dir, '__tests__', 'unit', `${name}.test.ts`),
    path.join(dir, '__tests__', 'unit', `${name}.spec.ts`),
    path.join(dir, '__tests__', 'unit', `${name}.unit.test.ts`),
    path.join(dir, '__tests__', 'unit', `${name}.unit.spec.ts`),
    path.join(dir, '__tests__', 'unit', `${name}.test.tsx`),
    path.join(dir, '__tests__', 'unit', `${name}.spec.tsx`),
    path.join(dir, '__tests__', 'unit', `${name}.unit.test.tsx`),
    path.join(dir, '__tests__', 'unit', `${name}.unit.spec.tsx`),
    // Parent directory __tests__ (for files in core/ subdirectory)
    path.join(parentDir, '__tests__', `${name}.test.ts`),
    path.join(parentDir, '__tests__', `${name}.spec.ts`),
    path.join(parentDir, '__tests__', 'unit', `${name}.test.ts`),
    path.join(parentDir, '__tests__', 'unit', `${name}.spec.ts`),
    path.join(parentDir, '__tests__', 'unit', `${name}.unit.test.ts`),
    path.join(parentDir, '__tests__', 'unit', `${name}.unit.spec.ts`),
  ]

  return possibilities.some((possiblePath) => fs.existsSync(possiblePath))
}

/**
 * Check if a file has a @test-pending marker
 * @returns {Promise<boolean>} True if the @test-pending marker is found, false otherwise
 */
async function hasTestPendingMarker(filePath: string, files: FileAccessor): Promise<boolean> {
  logger.debug({
    evt: 'fitness.checks.test_file_pairing.has_test_pending_marker',
    msg: 'Checking if file has a test-pending marker',
  })
  try {
    const content = await files.read(filePath)
    return content.slice(0, 500).includes('@test-pending')
  } catch {
    // @swallow-ok graceful degradation - return sentinel on failure
    return false
  }
}

/**
 * Recursively scan directory for source files
 */
async function scanDirectory(
  dir: string,
  cwd: string,
  files: FileAccessor,
): Promise<CheckViolation[]> {
  logger.debug({
    evt: 'fitness.checks.test_file_pairing.scan_directory',
    msg: 'Scanning directory for source files without test pairs',
  })
  const violations: CheckViolation[] = []

  // @lazy-ok -- validations inside loop depend on loop iteration data, not pre-await guards
  try {
    const entries = fs.readdirSync(dir)

    // Filter out entries that should be skipped
    const relevantEntries = entries.filter((entry) => !shouldSkipEntry(entry))

    for (const entry of relevantEntries) {
      const fullPath = path.join(dir, entry)
      const relativePath = path.relative(cwd, fullPath)
      const stats = fs.statSync(fullPath)

      if (stats.isDirectory()) {
        const subViolations = await scanDirectory(fullPath, cwd, files)
        violations.push(...subViolations)
      } else if (stats.isFile()) {
        if (!isSourceFile(entry, relativePath)) continue
        if (await hasTestPendingMarker(fullPath, files)) continue
        if (hasTestPair(dir, entry)) continue

        // @fitness-ignore-next-line null-safety -- path.parse() always returns a valid ParsedPath object with a name property
        const name = path.parse(entry).name
        const testDir = path.join(dir, '__tests__', 'unit')
        const expectedTestFile = path.join(testDir, `${name}.unit.test.ts`)
        const alternativeTestFile = path.join(testDir, `${name}.test.ts`)

        violations.push({
          line: 1,
          message: `Missing test file for ${entry}. Expected ${name}.test.ts or ${name}.spec.ts`,
          severity: 'error',
          type: 'missing-test',
          suggestion: `Create a test file: touch ${expectedTestFile} (or ${alternativeTestFile})`,
          match: entry,
          filePath: fullPath,
        })
      }
    }
  } catch {
    // @swallow-ok Skip inaccessible directories
  }

  return violations
}

/**
 * Analyze all files for test pairing
 */
// @fitness-ignore-next-line concurrency-safety -- async keyword required by analyzeAll interface contract; synchronous analysis implementation
async function analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
  logger.debug({
    evt: 'fitness.checks.test_file_pairing.analyze_all',
    msg: 'Analyzing all files for test pairing',
  })
  // Get the cwd from the first file path (all paths are absolute)
  const firstPath = files.paths[0]
  if (!firstPath) {
    return []
  }

  // Find the repo root by looking for packages directory
  let cwd = path.dirname(firstPath)
  while (cwd !== '/' && !fs.existsSync(path.join(cwd, 'packages'))) {
    cwd = path.dirname(cwd)
  }

  const scanDirs = [
    path.join(cwd, 'packages'),
    path.join(cwd, 'apps'),
    path.join(cwd, 'services'),
  ]

  const allViolations: CheckViolation[] = []
  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue
    // @fitness-ignore-next-line performance-anti-patterns -- sequential directory scanning required: each scan depends on shared file system state
    const dirViolations = await scanDirectory(dir, cwd, files)
    for (const violation of dirViolations) {
      allViolations.push(violation)
    }
  }

  return allViolations
}

/**
 * Check: testing/test-file-pairing
 *
 * Ensures every source file in services has a corresponding test file.
 */
export const testFilePairing = defineCheck({
  id: '6f807024-f5c3-4364-a1f3-ccd39d439df2',
  slug: 'test-file-pairing',
  scope: { languages: ['typescript'], concerns: ['backend', 'server'] },
  contentFilter: 'strip-strings',
  confidence: 'high',
  description: 'Ensures every source file has a corresponding test file',
  longDescription: `**Purpose:** Ensures every TypeScript source file in \`packages/\`, \`apps/\`, and \`services/\` has a corresponding test file, enforcing test coverage completeness.

**Detects:**
- Source \`.ts\`/\`.tsx\` files missing a paired test file (\`missing-test\`)
- Searches for test pairs in multiple locations: adjacent files, \`__tests__/\`, \`__tests__/unit/\`, and parent \`__tests__/\` directories
- Accepts \`.test.ts\`, \`.spec.ts\`, \`.unit.test.ts\`, and \`.unit.spec.ts\` suffixes
- Respects \`@test-pending\` marker in the first 500 characters of a file to suppress the violation
- Excludes index files, \`.d.ts\`, config files, interface/type-only files, enums, errors, and logger files

**Why it matters:** Unpaired source files represent gaps in test coverage that can lead to undetected regressions.

**Scope:** Codebase-specific convention. Cross-file analysis via \`analyzeAll\` recursively scanning \`packages/\`, \`apps/\`, and \`services/\`.`,
  tags: ['testing', 'coverage'],
  fileTypes: ['ts'],

  analyzeAll,
})
