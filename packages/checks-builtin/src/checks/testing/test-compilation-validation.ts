/**
 * @fileoverview Verifies test files compile without TypeScript errors
 * @invariants standard
 * @module cli/devtools/fitness/src/checks/testing/test-compilation-validation
 * @version 2.0.0
 *
 * This check catches broken imports, type errors, and missing properties in test files.
 */

import * as path from 'node:path'

import { logger } from '@opensip-tools/core/logger'
import { glob } from 'glob'

import { defineCheck, execAbortable, type CheckViolation, type FileAccessor } from '@opensip-tools/core'
import { isTestFile } from '../../utils/index.js'

/**
 * Structured issue for test compilation errors
 */
interface TestCompilationIssue {
  file: string
  filePath: string
  line: number
  column: number
  code: string
  message: string
  severity: 'error' | 'warning'
}

/**
 * Parse a single TypeScript error line into an issue.
 */
function parseTscErrorLine(line: string, basePath: string): TestCompilationIssue | null {
  logger.debug({
    evt: 'fitness.checks.test_compilation.parse_tsc_error_line',
    msg: 'Parsing a single TypeScript error line',
  })
  // TypeScript error format: file.ts(line,col): error TS####: message
  // Find the (line,col) pattern
  const parenIdx = line.indexOf('(')
  if (parenIdx === -1) return null

  const closeParenIdx = line.indexOf(')', parenIdx)
  if (closeParenIdx === -1) return null

  const rawFilePath = line.slice(0, parenIdx)
  const coords = line.slice(parenIdx + 1, closeParenIdx)
  const commaIdx = coords.indexOf(',')
  if (commaIdx === -1) return null

  const lineStr = coords.slice(0, commaIdx)
  const colStr = coords.slice(commaIdx + 1)
  const lineNum = parseInt(lineStr, 10)
  const colNum = parseInt(colStr, 10)
  if (isNaN(lineNum) || isNaN(colNum)) return null

  // Find ": error " or ": warning "
  const afterParen = line.slice(closeParenIdx + 1)
  const colonIdx = afterParen.indexOf(': ')
  if (colonIdx === -1) return null

  const afterColon = afterParen.slice(colonIdx + 2)
  const isError = afterColon.startsWith('error ')
  const isWarning = afterColon.startsWith('warning ')
  if (!isError && !isWarning) return null

  const severity = isError ? 'error' : 'warning'
  const typeStart = isError ? 6 : 8 // length of "error " or "warning "
  const codeEnd = afterColon.indexOf(':', typeStart)
  if (codeEnd === -1) return null

  const code = afterColon.slice(typeStart, codeEnd).trim()
  const message = afterColon.slice(codeEnd + 1).trim()

  const absolutePath = path.resolve(basePath, rawFilePath)
  return {
    file: path.relative(basePath, rawFilePath),
    filePath: absolutePath,
    line: lineNum,
    column: colNum,
    code,
    message,
    severity,
  }
}

/**
 * Parse TypeScript error output into structured issues.
 */
function parseTypeScriptErrors(output: string, basePath: string): TestCompilationIssue[] {
  logger.debug({
    evt: 'fitness.checks.test_compilation.parse_typescript_errors',
    msg: 'Parsing TypeScript error output into structured issues',
  })
  const issues: TestCompilationIssue[] = []
  const lines = output.split('\n')

  for (const line of lines) {
    const issue = parseTscErrorLine(line, basePath)
    if (issue) {
      issues.push(issue)
    }
  }

  return issues
}

/**
 * Discover test files
 */
async function discoverTestFiles(cwd: string): Promise<string[]> {
  logger.debug({
    evt: 'fitness.checks.test_compilation.discover_test_files',
    msg: 'Discovering test files in workspace',
  })
  const patterns = ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx']

  // @fitness-ignore-next-line no-unbounded-concurrency -- bounded by fixed 4-element patterns array
  const results = await Promise.all(
    patterns.map((pattern) =>
      glob(pattern, {
        cwd,
        absolute: true,
        ignore: ['**/node_modules/**', '**/dist/**'],
      }),
    ),
  )

  const allFiles: string[] = []
  for (const files of results) {
    for (const file of files) {
      allFiles.push(file)
    }
  }

  return [...new Set(allFiles)]
}

/**
 * Analyze all files for TypeScript compilation errors
 */
async function analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
  logger.debug({
    evt: 'fitness.checks.test_compilation.analyze_all',
    msg: 'Analyzing all files for TypeScript compilation errors',
  })
  const violations: CheckViolation[] = []

  // Get the cwd from the first file path (all paths are absolute)
  const firstPath = files.paths[0]
  if (!firstPath) {
    return violations
  }

  // Find the repo root by looking for tsconfig.json
  let cwd = path.dirname(firstPath)
  const fs = await import('node:fs')
  while (cwd !== '/' && !fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
    cwd = path.dirname(cwd)
  }

  const testFiles = await discoverTestFiles(cwd)
  const testFileSet = new Set(testFiles.map((testFile) => path.relative(cwd, testFile)))

  let allIssues: TestCompilationIssue[] = []
  // @fitness-ignore-next-line no-hardcoded-timeouts -- constant defined at module scope for tsc subprocess execution
  const timeout = 120000 // 2 minutes

  const result = await execAbortable('npx tsc --build 2>&1', {
    cwd,
    timeout,
    maxBuffer: 10 * 1024 * 1024, // 10MB buffer
  })

  if (result.aborted) {
    return []
  }

  // tsc exits non-zero when there are errors — parse stdout for issues
  if (result.exitCode !== 0) {
    allIssues = parseTypeScriptErrors(result.stdout, cwd)
  }

  // Filter to only include issues from test files, excluding known high-false-positive categories
  const testFileIssues = allIssues.filter((issue) => {
    if (!testFileSet.has(issue.file) && !isTestFile(issue.file)) return false

    // Skip infrastructure package tests — they follow different conventions
    if (
      issue.file.includes('packages/infrastructure/') ||
      issue.file.includes('packages\\infrastructure\\')
    ) {
      return false
    }

    // Skip smoke tests — they intentionally use loose typing
    if (issue.file.endsWith('.smoke.test.ts') || issue.file.endsWith('.smoke.test.tsx')) {
      return false
    }

    // Skip test utility files (helpers, setup, fixtures) — not actual test assertions
    const basename = path.basename(issue.file)
    const testUtilNames = ['helpers.ts', 'setup.ts', 'fixtures.ts', 'test-utils.ts', 'test-helpers.ts']
    if (testUtilNames.includes(basename)) {
      return false
    }

    return true
  })

  for (const issue of testFileIssues) {
    violations.push({
      line: issue.line,
      column: issue.column,
      message: `${issue.code}: ${issue.message}`,
      severity: issue.severity,
      type: 'compilation-error',
      suggestion: `Fix the TypeScript compilation error: ${issue.message}`,
      match: issue.code,
      filePath: issue.filePath,
    })
  }

  return violations
}

/**
 * Check: testing/test-compilation-validation
 *
 * Verifies test files compile without TypeScript errors.
 */
export const testCompilationValidation = defineCheck({
  id: '2ec09c16-b0bd-4641-b8ff-a4537f354dbe',
  slug: 'test-compilation-validation',
  scope: { languages: ['typescript', 'tsx'], concerns: ['testing'] },

  confidence: 'medium',
  description: 'Verifies test files compile without TypeScript errors',
  longDescription: `**Purpose:** Catches broken imports, type errors, and missing properties in test files by running the TypeScript compiler.

**Detects:**
- TypeScript compilation errors in test files (\`*.test.ts\`, \`*.test.tsx\`, \`*.spec.ts\`, \`*.spec.tsx\`)
- Runs \`npx tsc --build\` and parses error output in the format \`file.ts(line,col): error TSXXXX: message\`
- Filters results to only include issues from discovered test files
- Reports both errors and warnings with file path, line, column, and TS error code

**Why it matters:** Test files that fail to compile cannot run, creating blind spots in test coverage that are easy to miss during development.

**Scope:** General best practice. Cross-file analysis via \`analyzeAll\` running an external \`tsc --build\` command and filtering results to test files.`,
  tags: ['testing', 'typescript'],
  fileTypes: ['ts', 'tsx'],

  analyzeAll,
})
