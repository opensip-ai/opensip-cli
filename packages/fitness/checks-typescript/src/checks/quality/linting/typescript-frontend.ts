/**
 * @fileoverview TypeScript Frontend Compiler Check
 *
 * Validates TypeScript compilation for frontend apps (apps/*).
 */
// @fitness-ignore-file fitness-check-standards -- Uses fs for directory listing/stat operations, not file content reading

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { defineCheck, execAbortable, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness'

/**
 * TypeScript error line pattern.
 * The pattern is safe from ReDoS because:
 * - ([^(]+) uses negated character class with fixed delimiter (opening paren)
 * - (\d+) and (\d+) only match digits with fixed delimiters
 * - (error|warning) is a fixed alternation
 * - (TS\d+) has fixed prefix and only matches digits
 * - (.+) matches to end of line (anchored by $)
 */
// eslint-disable-next-line sonarjs/slow-regex -- [^(]+ bounded by '(' delimiter; each group has distinct delimiters
const TS_ERROR_PATTERN = /^([^(]+)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/gm

/**
 * Parse TypeScript error output
 */
function parseErrors(output: string): {
  file: string
  line: number
  code: string
  message: string
}[] {
  const errors: {
    file: string
    line: number
    code: string
    message: string
  }[] = []

  TS_ERROR_PATTERN.lastIndex = 0
  let match

  while ((match = TS_ERROR_PATTERN.exec(output)) !== null) {
    errors.push({
      /* v8 ignore next -- defensive nullish fallback */
      file: match[1] ?? '',
      // @fitness-ignore-next-line numeric-validation -- regex (\d+) guarantees digits only; parseInt always returns a valid integer
      line: Number.parseInt(match[2] ?? '0', 10),
      /* v8 ignore next -- defensive nullish fallback */
      code: match[5] ?? '',
      /* v8 ignore next -- defensive nullish fallback */
      message: match[6] ?? '',
    })
  }

  return errors
}

/**
 * Find apps with tsconfig.json in the apps directory
 */
function findAppsWithTsconfig(appsDir: string): string[] {
  if (!existsSync(appsDir)) {
    return []
  }
  return readdirSync(appsDir).filter((entry) => {
    const entryPath = join(appsDir, entry)
    return statSync(entryPath).isDirectory() && existsSync(join(entryPath, 'tsconfig.json'))
  })
}

/**
 * Find repo root by walking up from the given path.
 */
function findRepoRoot(startPath: string): string {
  let cwd = startPath
  while (cwd !== '/' && !existsSync(join(cwd, 'apps'))) {
    cwd = join(cwd, '..')
  }
  return cwd
}

/**
 * Create a generic compilation failure violation.
 */
function createGenericFailure(appPath: string, app: string): CheckViolation {
  return {
    filePath: appPath,
    line: 1,
    message: `App ${app} compilation failed`,
    severity: 'error',
    suggestion: `Run \`cd apps/${app} && npx tsc --noEmit\` to see the full error output`,
    match: app,
  }
}

/**
 * Convert parsed TypeScript errors to violations.
 */
function errorsToViolations(
  appPath: string,
  errors: { file: string; line: number; code: string; message: string }[],
): CheckViolation[] {
  return errors.slice(0, 10).map((err) => ({
    filePath: join(appPath, err.file),
    line: err.line,
    message: `${err.code}: ${err.message}`,
    severity: 'error' as const,
    suggestion: `Fix the TypeScript error: ${err.message}. See https://typescript.tv/errors/#${err.code.toLowerCase()} for explanation`,
    type: err.code,
    match: err.code,
  }))
}

/**
 * Process a single app's TypeScript compilation result.
 */
function processAppResult(
  appPath: string,
  app: string,
  exitCode: number | null,
  stdout: string,
): CheckViolation[] {
  if (exitCode === 0 || exitCode === null) {
    return []
  }

  const errors = parseErrors(stdout || '')
  if (errors.length === 0) {
    return [createGenericFailure(appPath, app)]
  }

  return errorsToViolations(appPath, errors)
}

/**
 * Check: quality/typescript-frontend
 *
 * Runs TypeScript compiler for frontend apps.
 *
 * Uses analyzeAll mode because we need to run tsc in multiple app directories.
 */
export const typescriptFrontend = defineCheck({
  id: 'a32ab706-f817-404c-835f-da79f64505c7',
  slug: 'typescript-frontend',
  scope: { languages: ['typescript', 'tsx'], concerns: ['frontend', 'ui'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Validates TypeScript compilation for frontend apps',
  longDescription: `**Purpose:** Validates that all frontend apps compile cleanly with the TypeScript compiler, running \`tsc --noEmit\` in each app directory that contains a \`tsconfig.json\`.

**Detects:**
- TypeScript compilation errors parsed from \`tsc --noEmit\` output using the pattern \`file(line,col): error TSxxxx: message\`
- Per-app compilation failures across all apps discovered in the \`apps/\` directory
- Reports up to 10 errors per app to avoid overwhelming output

**Why it matters:** Frontend apps have their own \`tsconfig.json\` settings and dependencies. Compiling each app independently catches type errors specific to that app's configuration and imported modules.

**Scope:** Cross-file analysis (\`analyzeAll\`) running \`npx tsc --noEmit\` in each discovered app directory. General best practice.`,
  tags: ['quality', 'type-safety', 'code-quality'],
  fileTypes: ['ts', 'tsx'],

  analyzeAll: async (files: FileAccessor): Promise<CheckViolation[]> => {
    const firstPath = files.paths[0]
    if (!firstPath) {
      return []
    }

    const cwd = findRepoRoot(firstPath)
    const appsDir = join(cwd, 'apps')
    const apps = findAppsWithTsconfig(appsDir)

    if (apps.length === 0) {
      return []
    }

    const violations: CheckViolation[] = []

    for (const app of apps) {
      const appPath = join(appsDir, app)

      const result = await execAbortable('npx tsc --noEmit 2>&1', {
        cwd: appPath,
        // @fitness-ignore-next-line no-hardcoded-timeouts -- framework default for tsc subprocess execution
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
      })

      if (result.aborted) {
        continue
      }

      violations.push(...processAppResult(appPath, app, result.exitCode, result.stdout))
    }

    return violations
  },
})
