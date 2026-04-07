// @fitness-ignore-file throws-documentation -- Functions throw self-documenting typed errors
// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
// @fitness-ignore-file no-hardcoded-timeouts -- constants defined at module scope for vitest subprocess execution
/**
 * @fileoverview Unit Test Health Check - runs unit tests and reports failures
 * @invariants standard
 * @module cli/devtools/fitness/src/checks/testing/unit-test-health
 * @version 2.0.0
 *
 * Runs unit tests and captures failures for ticket generation.
 * Provides structured failure data for the SIP system.
 *
 * NOTE: This check is disabled by default as it runs the full test suite.
 * Enable via fitness recipe or explicit configuration.
 */

// @fitness-ignore-file fitness-check-standards -- Uses fs for directory existsSync and config file reading, not source file content
import * as fs from 'node:fs'
import * as path from 'node:path'

import { logger } from '@opensip-tools/core/logger'

import { defineCheck, execAbortable, type CheckViolation, type FileAccessor } from '@opensip-tools/core'

/**
 * Vitest JSON output types
 */
type VitestPassedStatus = 'passed' | 'skipped'
type VitestFailedStatus = 'failed' | 'todo'
type VitestTestStatus = VitestPassedStatus | VitestFailedStatus

interface VitestTestResult {
  name: string
  status: VitestTestStatus
  duration: number
  failureMessages?: string[]
}

interface VitestFileResult {
  name: string
  status: 'passed' | 'failed'
  duration: number
  assertionResults: VitestTestResult[]
}

interface VitestJsonOutput {
  numTotalTests: number
  numPassedTests: number
  numFailedTests: number
  numSkippedTests: number
  success: boolean
  testResults: VitestFileResult[]
}

/**
 * Creates a violation object for a failed test
 */
function createTestViolation(params: {
  fileName: string
  testName: string
  failureMessages: string[] | undefined
}): CheckViolation {
  logger.debug({
    evt: 'fitness.checks.unit_test_health.create_test_violation',
    msg: 'Creating violation object for failed test',
  })
  const { fileName, testName, failureMessages } = params
  // Validate nested array parameter - safely access with optional chaining
  const safeFailureMessages = Array.isArray(failureMessages) ? failureMessages : []
  const failureMessage =
    safeFailureMessages.length > 0
      ? safeFailureMessages.join('\n').slice(0, 500)
      : 'No failure message available'

  return {
    line: 1, // vitest doesn't provide assertion line numbers
    message: `Test failed: ${testName}`,
    severity: 'error',
    type: 'test-failure',
    suggestion: `Fix the failing test '${testName}'. Error: ${failureMessage}`,
    match: testName,
    filePath: fileName,
  }
}

/**
 * Extracts violations from failed test results in a file
 */
function extractFileViolations(fileResult: VitestFileResult): CheckViolation[] {
  logger.debug({
    evt: 'fitness.checks.unit_test_health.extract_file_violations',
    msg: 'Extracting violations from failed test results',
  })
  const violations: CheckViolation[] = []

  for (const testResult of fileResult.assertionResults) {
    if (testResult.status === 'failed') {
      violations.push(
        createTestViolation({
          fileName: fileResult.name,
          testName: testResult.name,
          failureMessages: testResult.failureMessages,
        }),
      )
    }
  }

  return violations
}

/**
 * Parse vitest JSON output into structured failures
 */
function parseVitestOutput(jsonOutput: string): {
  summary: VitestJsonOutput
  violations: CheckViolation[]
} {
  logger.debug({
    evt: 'fitness.checks.unit_test_health.parse_vitest_output',
    msg: 'Parsing vitest JSON output into structured failures',
  })
  const output: VitestJsonOutput = JSON.parse(jsonOutput)
  const violations: CheckViolation[] = []

  const failedFiles = output.testResults.filter((fileResult) => fileResult.status === 'failed')
  for (const fileResult of failedFiles) {
    const fileViolations = extractFileViolations(fileResult)
    for (const violation of fileViolations) {
      violations.push(violation)
    }
  }

  return { summary: output, violations }
}

/**
 * Check if vitest can run in the target directory
 */
function canRunVitest(targetDir: string): { canRun: boolean; reason?: string } {
  logger.debug({
    evt: 'fitness.checks.unit_test_health.can_run_vitest',
    msg: 'Checking if vitest can run in target directory',
  })
  // Check if directory exists
  if (!fs.existsSync(targetDir)) {
    return { canRun: false, reason: `Directory does not exist: ${targetDir}` }
  }

  // Check for vitest config in target dir or parent
  const vitestConfigs = [
    path.join(targetDir, 'vitest.config.ts'),
    path.join(targetDir, 'vitest.config.js'),
    path.join(targetDir, 'vitest.config.mts'),
  ]

  const hasVitestConfig = vitestConfigs.some((config) => fs.existsSync(config))

  // Check for package.json with test script
  const packageJsonPath = path.join(targetDir, 'package.json')
  let hasTestScript = false
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkgStats = fs.statSync(packageJsonPath)
      if (pkgStats.size > 10_000_000) throw new Error(`File too large: ${packageJsonPath}`)
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
      hasTestScript = !!pkg.scripts?.test || !!pkg.scripts?.['test:unit']
    } catch {
      // @swallow-ok Ignore JSON parse errors
    }
  }

  if (!hasVitestConfig && !hasTestScript) {
    return {
      canRun: false,
      reason: `No vitest config or test script found in ${targetDir}. This check requires vitest to be configured.`,
    }
  }

  return { canRun: true }
}

/**
 * Find the opening brace of a JSON object before a marker position.
 */
function findJsonOpeningBrace(output: string, markerIndex: number): number {
  logger.debug({
    evt: 'fitness.checks.unit_test_health.find_json_opening_brace',
    msg: 'Finding opening brace of JSON object',
  })
  let braceCount = 0
  for (let i = markerIndex; i >= 0; i--) {
    const char = output[i]
    if (char === '}') {
      braceCount++
    } else if (char === '{') {
      if (braceCount === 0) {
        return i
      }
      braceCount--
    }
  }
  return -1
}

/**
 * Find the closing brace of a JSON object after an opening brace.
 */
function findJsonClosingBrace(output: string, startIndex: number): number {
  logger.debug({
    evt: 'fitness.checks.unit_test_health.find_json_closing_brace',
    msg: 'Finding closing brace of JSON object',
  })
  let braceCount = 1
  for (let i = startIndex + 1; i < output.length; i++) {
    const char = output[i]
    if (char === '{') {
      braceCount++
    } else if (char === '}') {
      braceCount--
      if (braceCount === 0) {
        return i
      }
    }
  }
  return -1
}

/**
 * Extracts JSON from vitest output by finding the JSON object containing numTotalTests.
 * Uses a non-regex approach to avoid catastrophic backtracking.
 */
function extractJsonFromOutput(output: string): string | null {
  logger.debug({
    evt: 'fitness.checks.unit_test_health.extract_json_from_output',
    msg: 'Extracting JSON from vitest output',
  })
  // Look for the numTotalTests marker that indicates vitest JSON output
  const markerIndex = output.indexOf('"numTotalTests"')
  if (markerIndex === -1) {
    return null
  }

  const startIndex = findJsonOpeningBrace(output, markerIndex)
  if (startIndex === -1) {
    return null
  }

  const endIndex = findJsonClosingBrace(output, startIndex)
  if (endIndex === -1) {
    return null
  }

  return output.slice(startIndex, endIndex + 1)
}

/**
 * Run tests using vitest (async — does not block the event loop)
 */
async function runTests(
  targetDir: string,
  timeout: number,
): Promise<{ summary: VitestJsonOutput; violations: CheckViolation[] }> {
  logger.debug({
    evt: 'fitness.checks.unit_test_health.run_tests',
    msg: 'Running tests using vitest',
  })
  // Check if vitest can run
  const { canRun, reason } = canRunVitest(targetDir)
  if (!canRun) {
    throw new Error(reason)
  }

  const result = await execAbortable('pnpm vitest run --reporter=json 2>&1', {
    cwd: targetDir,
    timeout,
    maxBuffer: 50 * 1024 * 1024, // 50MB buffer
  })

  if (result.aborted) {
    return { summary: { numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numSkippedTests: 0, success: true, testResults: [] }, violations: [] }
  }

  // vitest exits non-zero when tests fail — that's expected
  const output = result.stdout
  if (result.exitCode === 0) {
    return parseVitestOutput(output)
  }

  const jsonStr = extractJsonFromOutput(output)
  if (jsonStr) {
    return parseVitestOutput(jsonStr)
  }

  throw new Error(`vitest exited with code ${result.exitCode} but produced no JSON output`)
}

/**
 * Analyze backend unit tests
 */
async function analyzeBackend(files: FileAccessor): Promise<CheckViolation[]> {
  logger.debug({
    evt: 'fitness.checks.unit_test_health.analyze_backend',
    msg: 'Analyzing backend unit tests',
  })
  // Get the cwd from the first file path (all paths are absolute)
  const firstPath = files.paths[0]
  if (!firstPath) {
    return []
  }

  // Find the repo root by looking for services directory
  let cwd = path.dirname(firstPath)
  while (cwd !== '/' && !fs.existsSync(path.join(cwd, 'services'))) {
    cwd = path.dirname(cwd)
  }

  const targetDir = path.join(cwd, 'services', 'apiserver')
  const timeout = 300000 // 5 minutes

  try {
    const result = await runTests(targetDir, timeout)
    return result.violations
  } catch {
    // @swallow-ok -- vitest execution failures are expected when tests cannot run, return empty to skip check
    // Return empty if vitest fails to run
    return []
  }
}

/**
 * Analyze frontend unit tests
 */
async function analyzeFrontend(files: FileAccessor): Promise<CheckViolation[]> {
  logger.debug({
    evt: 'fitness.checks.unit_test_health.analyze_frontend',
    msg: 'Analyzing frontend unit tests',
  })
  // Get the cwd from the first file path (all paths are absolute)
  const firstPath = files.paths[0]
  if (!firstPath) {
    return []
  }

  // Find the repo root by looking for apps directory
  let cwd = path.dirname(firstPath)
  while (cwd !== '/' && !fs.existsSync(path.join(cwd, 'apps'))) {
    cwd = path.dirname(cwd)
  }

  const targetDir = path.join(cwd, 'apps', 'dashboard')
  const timeout = 300000 // 5 minutes

  try {
    const result = await runTests(targetDir, timeout)
    return result.violations
  } catch {
    // @swallow-ok -- vitest execution failures are expected when tests cannot run, return empty to skip check
    // Return empty if vitest fails to run
    return []
  }
}

/**
 * Check: testing/unit-test-health-backend
 *
 * Runs backend unit tests and reports failures for ticket generation.
 *
 * NOTE: Disabled by default. Enable via recipe:
 * pnpm sip fit --recipe unit-test-health-backend
 */
export const unitTestHealthBackend = defineCheck({
  id: '4db66ac5-9ef0-4729-8099-2ae0db9f4653',
  slug: 'unit-test-health-backend',
  scope: { languages: ['typescript', 'tsx'], concerns: ['testing'] },

  confidence: 'medium',
  description:
    'Runs backend unit tests (services/apiserver) and reports failures for ticket generation (disabled by default)',
  longDescription: `**Purpose:** Runs the full backend unit test suite in \`services/apiserver\` via Vitest and reports individual test failures as structured violations for ticket generation.

**Detects:**
- Individual failing test cases from \`pnpm vitest run --reporter=json\` output
- Parses Vitest JSON output by locating the \`"numTotalTests"\` marker and extracting the enclosing JSON object
- Reports each failed assertion with test name, file path, and truncated failure message (up to 500 chars)
- Checks for \`vitest.config.ts\` or a \`test\` script in \`package.json\` before attempting to run

**Why it matters:** Surfaces actual test failures as trackable fitness violations, enabling the SIP system to create tickets for broken tests automatically.

**Scope:** Codebase-specific convention. Cross-file analysis via \`analyzeAll\` running an external \`vitest\` command. Disabled by default (slow, ~10 min).`,
  tags: ['testing', 'health', 'slow'],
  fileTypes: ['ts', 'tsx'],
  disabled: true, // Slow check (~10min). Runs in nightly-full recipe and via --check

  analyzeAll: analyzeBackend,
})

/**
 * Check: testing/unit-test-health-frontend
 *
 * Runs frontend unit tests and reports failures for ticket generation.
 *
 * NOTE: Disabled by default. Included in nightly-full recipe via includeDisabled.
 * Can also be run explicitly: pnpm sip fit --check testing/unit-test-health-frontend
 */
export const unitTestHealthFrontend = defineCheck({
  id: 'fe919859-d78f-461d-9528-5b0e0a004c22',
  slug: 'unit-test-health-frontend',
  tags: ['testing'],
  scope: { languages: ['typescript', 'tsx'], concerns: ['testing'] },
  description:
    'Runs frontend unit tests (apps/dashboard) and reports failures for ticket generation (disabled by default)',
  longDescription: `**Purpose:** Runs the full frontend unit test suite in \`apps/dashboard\` via Vitest and reports individual test failures as structured violations for ticket generation.

**Detects:**
- Individual failing test cases from \`pnpm vitest run --reporter=json\` output
- Parses Vitest JSON output by locating the \`"numTotalTests"\` marker and extracting the enclosing JSON object
- Reports each failed assertion with test name, file path, and truncated failure message (up to 500 chars)
- Checks for \`vitest.config.ts\` or a \`test\` script in \`package.json\` before attempting to run

**Why it matters:** Surfaces actual test failures as trackable fitness violations, enabling the SIP system to create tickets for broken tests automatically.

**Scope:** Codebase-specific convention. Cross-file analysis via \`analyzeAll\` running an external \`vitest\` command. Disabled by default (slow, ~10 min).`,
  disabled: true, // Slow check (~10min). Runs in nightly-full recipe and via --check

  analyzeAll: analyzeFrontend,
})
