// @fitness-ignore-file fitness-check-standards -- Dockerfile check scans non-standard file types that do not map to a fileTypes extension array
// @fitness-ignore-file file-length-limits -- Complex module with tightly coupled logic; refactoring would risk breaking changes
/**
 * @fileoverview Docker best practices fitness check
 * @invariants
 * - Security rules (non-root user, no secrets, production-dependencies) are errors (blocking)
 * - Efficiency rules (layer ordering, multi-stage, no-build-tools-in-runner) are warnings (advisory)
 * - All Dockerfiles in the repository are scanned
 */

import * as path from 'node:path'

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

// =============================================================================
// TYPES
// =============================================================================

interface DockerfileViolation {
  file: string
  filePath: string
  line: number
  rule: string
  message: string
  severity: 'error' | 'warning'
  suggestion?: string
}

interface AnalysisState {
  hasNonRootUser: boolean
  hasHealthcheck: boolean
  hasFrozenLockfile: boolean
  hasNodeEnvProduction: boolean
  hasProductionDepsFlag: boolean
  baseImages: string[]
  fromCount: number
  isInRunnerStage: boolean
  runnerStageBaseImage: string | null
  lastFromLine: number
  stageNames: string[]
  runnerCopiesNodeModules: boolean
  runnerNodeModulesLine: number
  runnerInheritsBuildStage: boolean
  runnerFromLine: number
}

// =============================================================================
// PRE-COMPILED REGEX PATTERNS (for safety and performance)
// =============================================================================

// Maximum line length for regex matching to prevent DoS
const MAX_DOCKERFILE_LINE_LENGTH = 2000

/**
 * Safely truncate a line for regex matching.
 */
function safeDockerLine(line: string): string {
  return line.length > MAX_DOCKERFILE_LINE_LENGTH ? line.slice(0, MAX_DOCKERFILE_LINE_LENGTH) : line
}

// Secret patterns - using word character classes with bounded quantifiers
// Using \w for alphanumeric plus underscore, adding dash separately with explicit bounds
const SECRET_API_KEY_PATTERN =
  /(?:API_KEY|APIKEY|API_SECRET|SECRET_KEY|AUTH_TOKEN|ACCESS_TOKEN)\s{0,10}=\s{0,10}['"]?[\w-]{16,200}/i
const SECRET_AWS_PATTERN =
  /(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)\s{0,10}=\s{0,10}['"]?[\w/+=]{20,200}/i
const SECRET_DB_URL_PATTERN =
  /(?:DATABASE_URL|DB_URL|MONGO_URL|REDIS_URL)\s{0,10}=\s{0,10}['"]?[a-z]{1,20}:\/\/[^:]{1,100}:[^@]{1,100}@/i
const SECRET_PASSWORD_PATTERN =
  /(?:PASSWORD|PASSWD|DB_PASSWORD|ADMIN_PASSWORD)\s{0,10}=\s{0,10}['"]?[^\s'"]{8,200}/i
const SECRET_PRIVATE_KEY_PATTERN = /-----BEGIN\s{1,10}(?:RSA\s{1,10})?PRIVATE\s{1,10}KEY-----/
const SECRET_JWT_PATTERN = /JWT_SECRET\s{0,10}=\s{0,10}['"]?[\w-]{32,500}/i

const SECRET_PATTERNS = [
  SECRET_API_KEY_PATTERN,
  SECRET_AWS_PATTERN,
  SECRET_DB_URL_PATTERN,
  SECRET_PASSWORD_PATTERN,
  SECRET_PRIVATE_KEY_PATTERN,
  SECRET_JWT_PATTERN,
]

// Package manager patterns - pre-compiled with bounded quantifiers
const PNPM_INSTALL_PATTERN = /pnpm\s{1,10}install(?!\s{1,10}--frozen-lockfile)/
const NPM_INSTALL_PATTERN =
  /npm\s{1,10}(?:install|ci)(?!\s{1,10}-g)(?!\s{1,10}--global)(?!\s{1,10}--ci)(?!\s{1,10}--frozen-lockfile)/
const YARN_INSTALL_PATTERN =
  /yarn\s{1,10}install(?!\s{1,10}--frozen-lockfile)(?!\s{1,10}--immutable)/

interface PackageManagerPattern {
  pattern: RegExp
  manager: string
  fix: string
}

const PACKAGE_MANAGER_PATTERNS: PackageManagerPattern[] = [
  { pattern: PNPM_INSTALL_PATTERN, manager: 'pnpm', fix: '--frozen-lockfile' },
  { pattern: NPM_INSTALL_PATTERN, manager: 'npm', fix: '--ci or npm ci' },
  {
    pattern: YARN_INSTALL_PATTERN,
    manager: 'yarn',
    fix: '--frozen-lockfile or --immutable',
  },
]

// Cache mount patterns - pre-compiled with bounded quantifiers
const PKG_INSTALL_PATTERN = /(?:pnpm|npm|yarn)\s{1,10}install(?!\s{1,10}-g)(?!\s{1,10}--global)/

// Production dependency patterns - pre-compiled with bounded quantifiers
const PROD_DEPS_FLAG_PATTERN = /(?:--prod\b|--production\b)/

// Other patterns - pre-compiled with bounded quantifiers
const APT_UPGRADE_PATTERN = /apt-get\s{1,10}upgrade/i
const COPY_PATTERN = /COPY\s{1,10}(?:--from=\S{1,100}\s{1,10})?(\S{1,500})/i
const PACKAGE_FILE_COPY_PATTERN =
  /COPY\s{1,10}[^\n]{0,500}(?:package\.json|pnpm-lock|yarn\.lock|package-lock)/i
const NODE_MODULES_FROM_STAGE_PATTERN = /COPY\s{1,10}--from=\S{1,100}[^\n]{0,500}node_modules/i
const FROM_IMAGE_PATTERN = /FROM\s{1,10}(\S{1,200})/i
const FROM_STAGE_PATTERN = /\bAS\s{1,10}(\w{1,100})/i
const USER_PATTERN = /USER\s{1,10}(\S{1,100})/i
const NODE_ENV_PROD_PATTERN = /NODE_ENV\s{0,10}=\s{0,10}production/i

const RUNNER_STAGE_NAMES = ['runner', 'production', 'prod', 'final', 'runtime']

// =============================================================================
// ANALYSIS FUNCTIONS
// =============================================================================

function checkForSecrets(
  line: string,
  lineNum: number,
  file: string,
  filePath: string,
): DockerfileViolation | null {
  const safeLine = safeDockerLine(line)
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(safeLine)) {
      return {
        file,
        filePath,
        line: lineNum,
        rule: 'no-hardcoded-secrets',
        message: 'Hardcoded secret detected in Dockerfile',
        severity: 'error',
        suggestion:
          'Use build arguments, runtime environment variables, or a secrets manager instead',
      }
    }
  }
  return null
}

function checkRunCommand(
  line: string,
  lineNum: number,
  file: string,
  filePath: string,
): { violations: DockerfileViolation[]; hasFrozenLockfileViolation: boolean } {
  const violations: DockerfileViolation[] = []
  let hasFrozenLockfileViolation = false
  const safeLine = safeDockerLine(line)

  for (const { pattern, manager, fix } of PACKAGE_MANAGER_PATTERNS) {
    if (pattern.test(safeLine)) {
      hasFrozenLockfileViolation = true
      violations.push({
        file,
        filePath,
        line: lineNum,
        rule: 'frozen-lockfile',
        message: `${manager} install without frozen lockfile flag`,
        severity: 'error',
        suggestion: `Add ${fix} to ensure reproducible builds`,
      })
    }
  }

  if (APT_UPGRADE_PATTERN.test(safeLine)) {
    violations.push({
      file,
      filePath,
      line: lineNum,
      rule: 'no-apt-upgrade',
      message: 'apt-get upgrade makes builds non-reproducible',
      severity: 'warning',
      suggestion: 'Pin specific package versions instead of upgrading all packages',
    })
  }

  return { violations, hasFrozenLockfileViolation }
}

interface CheckCopyOrderOptions {
  line: string
  lineNum: number
  file: string
  filePath: string
  lines: string[]
  lastFromLine: number
  lineIndex: number
}

function checkCopyOrder(options: CheckCopyOrderOptions): DockerfileViolation | null {
  const { line, lineNum, file, filePath, lines, lastFromLine, lineIndex } = options

  // Validate array parameter
  if (!Array.isArray(lines)) {
    return null
  }

  const safeLine = safeDockerLine(line)
  const copyMatch = COPY_PATTERN.exec(safeLine)
  if (copyMatch?.[1] !== '.' && copyMatch?.[1] !== './') return null
  if (safeLine.includes('--from=')) return null

  const stageLines = lines.slice(lastFromLine, lineIndex)

  const hasPackageFileCopy = stageLines.some((l) =>
    PACKAGE_FILE_COPY_PATTERN.test(safeDockerLine(l)),
  )

  const hasNodeModulesFromStage = stageLines.some((l) =>
    NODE_MODULES_FROM_STAGE_PATTERN.test(safeDockerLine(l)),
  )

  if (!hasPackageFileCopy && !hasNodeModulesFromStage) {
    return {
      file,
      filePath,
      line: lineNum,
      rule: 'copy-order',
      message: 'COPY . before copying dependency files',
      severity: 'warning',
      suggestion:
        'Copy package.json and lockfile first, run install, then copy source for better layer caching',
    }
  }
  return null
}

function checkCacheMount(
  line: string,
  lineNum: number,
  file: string,
  filePath: string,
): DockerfileViolation | null {
  const safeLine = safeDockerLine(line)
  if (PKG_INSTALL_PATTERN.test(safeLine) && !safeLine.includes('--mount=type=cache')) {
    return {
      file,
      filePath,
      line: lineNum,
      rule: 'cache-mount',
      message: 'Package install without BuildKit cache mount',
      severity: 'warning',
      suggestion:
        'Add --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store to cache the package store across builds',
    }
  }
  return null
}

function processFromLine(line: string, lineNum: number, state: AnalysisState): void {
  state.fromCount++
  state.lastFromLine = lineNum
  const safeLine = safeDockerLine(line)
  const match = FROM_IMAGE_PATTERN.exec(safeLine)
  const baseImage = match?.[1] ?? null
  if (baseImage) state.baseImages.push(baseImage)

  const stageMatch = FROM_STAGE_PATTERN.exec(safeLine)
  const stageName = stageMatch?.[1]?.toLowerCase() ?? null

  // Determine if this is the runner stage
  if (stageName) {
    state.isInRunnerStage = RUNNER_STAGE_NAMES.includes(stageName)
  } else if (state.fromCount > 1) {
    state.isInRunnerStage = true
  }

  if (state.isInRunnerStage) {
    state.runnerStageBaseImage = baseImage
    state.runnerFromLine = lineNum

    // Check if runner's base image references a previously defined build stage
    if (baseImage) {
      const baseImageLower = baseImage.toLowerCase()
      state.runnerInheritsBuildStage = state.stageNames.includes(baseImageLower)
    }
  }

  // Record stage name after checks (to avoid self-matching)
  if (stageName) {
    state.stageNames.push(stageName)
  }
}

function addMissingBestPracticeViolations(
  file: string,
  filePath: string,
  lineCount: number,
  state: AnalysisState,
): DockerfileViolation[] {
  const violations: DockerfileViolation[] = []
  const hasMultiStage = state.fromCount >= 2

  if (!hasMultiStage && state.fromCount > 0) {
    violations.push({
      file,
      filePath,
      line: 1,
      rule: 'multi-stage-build',
      message: 'Dockerfile does not use multi-stage build',
      severity: 'error',
      suggestion:
        'Use separate stages for building and running to reduce image size and attack surface',
    })
  }

  if (!state.hasNonRootUser && state.fromCount > 0) {
    violations.push({
      file,
      filePath,
      line: lineCount,
      rule: 'non-root-user',
      message: 'Dockerfile does not specify a non-root user',
      severity: 'error',
      suggestion:
        'Add USER directive with a non-root user: RUN addgroup --system app && adduser --system --ingroup app app\\nUSER app',
    })
  }

  if (!state.hasHealthcheck && state.fromCount > 0) {
    violations.push({
      file,
      filePath,
      line: lineCount,
      rule: 'healthcheck',
      message: 'Dockerfile does not include a HEALTHCHECK instruction',
      severity: 'warning',
      suggestion: 'Add HEALTHCHECK to help orchestrators verify container health',
    })
  }

  // Check NODE_ENV only if runner stage uses Node.js
  const runnerUsesNode = state.runnerStageBaseImage?.includes('node') ?? false
  if (runnerUsesNode && !state.hasNodeEnvProduction) {
    violations.push({
      file,
      filePath,
      line: lineCount,
      rule: 'node-env-production',
      message: 'NODE_ENV=production not set in runtime stage',
      severity: 'warning',
      suggestion: 'Add ENV NODE_ENV=production in the runner stage for Node.js optimizations',
    })
  }

  // Check if runner copies node_modules without production-only dependency resolution
  if (state.runnerCopiesNodeModules && !state.hasProductionDepsFlag) {
    violations.push({
      file,
      filePath,
      line: state.runnerNodeModulesLine,
      rule: 'production-dependencies',
      message: 'Runtime image copies node_modules without production-only dependency resolution',
      severity: 'error',
      suggestion:
        'Use "pnpm deploy --prod" to create a production bundle, or add --prod to install command to exclude devDependencies from the runtime image',
    })
  }

  // Check if runner stage inherits from a build stage (includes build tools)
  if (state.runnerInheritsBuildStage) {
    violations.push({
      file,
      filePath,
      line: state.runnerFromLine,
      rule: 'no-build-tools-in-runner',
      message:
        'Runtime stage inherits from a build stage that may include build tools (pnpm, corepack, etc.)',
      severity: 'warning',
      suggestion:
        'Use a clean base image (e.g., node:20-alpine) for the runtime stage instead of inheriting from a build stage',
    })
  }

  return violations
}

function analyzeDockerfile(content: string, filePath: string, file: string): DockerfileViolation[] {
  const lines = content.split('\n')
  const violations: DockerfileViolation[] = []

  const state: AnalysisState = {
    hasNonRootUser: false,
    hasHealthcheck: false,
    hasFrozenLockfile: true,
    hasNodeEnvProduction: false,
    hasProductionDepsFlag: false,
    baseImages: [],
    fromCount: 0,
    isInRunnerStage: false,
    runnerStageBaseImage: null,
    lastFromLine: 0,
    stageNames: [],
    runnerCopiesNodeModules: false,
    runnerNodeModulesLine: 0,
    runnerInheritsBuildStage: false,
    runnerFromLine: 0,
  }

  for (let i = 0; i < lines.length; i++) {
    processDockerfileLine({
      line: lines[i],
      index: i,
      lines,
      state,
      violations,
      file,
      filePath,
    })
  }

  // Add violations for missing best practices
  violations.push(...addMissingBestPracticeViolations(file, filePath, lines.length, state))

  return violations
}

interface ProcessDockerfileLineOptions {
  line: string | undefined
  index: number
  lines: string[]
  state: AnalysisState
  violations: DockerfileViolation[]
  file: string
  filePath: string
}

function processUserLine(trimmedLine: string, state: AnalysisState): void {
  const safeLine = safeDockerLine(trimmedLine)
  const userMatch = USER_PATTERN.exec(safeLine)
  if (userMatch?.[1] && userMatch[1] !== 'root') {
    state.hasNonRootUser = true
  }
}

function processRunLine(
  trimmedLine: string,
  lineNum: number,
  file: string,
  filePath: string,
  state: AnalysisState,
  violations: DockerfileViolation[],
): void {
  const runResult = checkRunCommand(trimmedLine, lineNum, file, filePath)
  violations.push(...runResult.violations)
  if (runResult.hasFrozenLockfileViolation) state.hasFrozenLockfile = false

  const cacheMountViolation = checkCacheMount(trimmedLine, lineNum, file, filePath)
  if (cacheMountViolation) violations.push(cacheMountViolation)

  if (PROD_DEPS_FLAG_PATTERN.test(safeDockerLine(trimmedLine))) {
    state.hasProductionDepsFlag = true
  }
}

function processCopyLine(
  trimmedLine: string,
  lineNum: number,
  index: number,
  lines: string[],
  file: string,
  filePath: string,
  state: AnalysisState,
  violations: DockerfileViolation[],
): void {
  const copyViolation = checkCopyOrder({
    line: trimmedLine,
    lineNum,
    file,
    filePath,
    lines,
    lastFromLine: state.lastFromLine,
    lineIndex: index,
  })
  if (copyViolation) violations.push(copyViolation)

  if (state.isInRunnerStage && NODE_MODULES_FROM_STAGE_PATTERN.test(safeDockerLine(trimmedLine))) {
    state.runnerCopiesNodeModules = true
    state.runnerNodeModulesLine = lineNum
  }
}

function processDockerfileLine(options: ProcessDockerfileLineOptions): void {
  const { line, index, lines, state, violations, file, filePath } = options
  const trimmedLine = line?.trim() ?? ''
  if (!trimmedLine || trimmedLine.startsWith('#')) return

  const upperLine = trimmedLine.toUpperCase()
  const lineNum = index + 1

  if (upperLine.startsWith('FROM ')) {
    processFromLine(trimmedLine, lineNum, state)
  }

  if (upperLine.startsWith('USER ')) {
    processUserLine(trimmedLine, state)
  }

  if (upperLine.startsWith('HEALTHCHECK ')) {
    state.hasHealthcheck = true
  }

  if (NODE_ENV_PROD_PATTERN.test(safeDockerLine(trimmedLine))) {
    state.hasNodeEnvProduction = true
  }

  const secretViolation = checkForSecrets(trimmedLine, lineNum, file, filePath)
  if (secretViolation) violations.push(secretViolation)

  if (upperLine.startsWith('RUN ')) {
    processRunLine(trimmedLine, lineNum, file, filePath, state, violations)
  }

  if (upperLine.startsWith('COPY ')) {
    processCopyLine(trimmedLine, lineNum, index, lines, file, filePath, state, violations)
  }
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: architecture/docker-best-practices
 *
 * Validates Dockerfiles follow security and efficiency best practices:
 * - Multi-stage builds
 * - Non-root user
 * - No hardcoded secrets
 * - Frozen lockfiles for package managers
 * - HEALTHCHECK instruction
 * - Proper COPY order for layer caching
 * - Production-only dependencies in runtime image (no devDependencies)
 * - No build tools (pnpm, corepack) inherited in runtime stage
 * - BuildKit cache mounts for package install commands
 */
export const dockerBestPractices = defineCheck({
  id: '9870251d-6d3c-49b7-a680-864bc892b19e',
  slug: 'docker-best-practices',
  disabled: true,
  scope: { languages: ['json', 'typescript', 'yaml'], concerns: ['config'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Validate Dockerfiles follow security and efficiency best practices',
  longDescription: `**Purpose:** Enforces security and efficiency best practices in Dockerfiles across the repository.

**Detects:**
- Hardcoded secrets (API keys, AWS credentials, passwords, JWT secrets, private keys)
- Missing multi-stage builds, missing non-root \`USER\` directive, missing \`HEALTHCHECK\`
- Package installs without \`--frozen-lockfile\` (pnpm/npm/yarn)
- \`COPY .\` before dependency file copy (poor layer caching)
- Missing BuildKit cache mounts on package installs
- Runtime stage inheriting from build stage or copying \`node_modules\` without \`--prod\`

**Why it matters:** Prevents security vulnerabilities (running as root, leaked secrets), non-reproducible builds, and bloated production images.

**Scope:** General best practice. Analyzes each file individually.`,
  tags: ['docker', 'security', 'best-practices', 'architecture'],

  analyze(content: string, filePath: string): CheckViolation[] {
    const file = path.relative(process.cwd(), filePath)
    const violations = analyzeDockerfile(content, filePath, file)

    return violations.map((violation) => ({
      line: violation.line,
      message: violation.message + (violation.suggestion ? ` (${violation.suggestion})` : ''),
      severity: violation.severity,
      suggestion: violation.suggestion ?? 'See Docker best practices documentation.',
      match: violation.rule,
      type: violation.rule,
    }))
  },
})
