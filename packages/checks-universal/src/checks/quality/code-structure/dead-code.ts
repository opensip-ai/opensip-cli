// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
/**
 * @fileoverview Dead code detection using Knip
 *
 * Detects unused files, exports, types, and dependencies using Knip.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { defineCheck, type CheckViolation } from '@opensip-tools/fitness'

/**
 * Locations Knip does NOT auto-discover but many repos use for tool configs.
 * When present, we pass --config explicitly so the check matches how
 * the repo's own scripts invoke Knip.
 */
const NON_DEFAULT_KNIP_CONFIG_PATHS = [
  '.config/knip.json',
  '.config/knip.jsonc',
  '.config/knip.ts',
  '.config/knip.js',
]

function findKnipConfig(projectRoot: string): string | null {
  for (const candidate of NON_DEFAULT_KNIP_CONFIG_PATHS) {
    const full = path.join(projectRoot, candidate)
    if (fs.existsSync(full)) return candidate
  }
  return null
}

/**
 * Knip JSON output structure
 */
interface KnipOutput {
  files?: string[]
  issues?: Array<{
    file: string
    exports?: Array<{ name?: string; symbol?: string; line?: number }>
    types?: Array<{ name?: string; symbol?: string; line?: number }>
    dependencies?: Array<{ name?: string; line?: number }>
    devDependencies?: Array<{ name?: string; line?: number }>
    unlisted?: Array<{ name?: string; line?: number }>
    enumMembers?: Record<string, Array<{ name?: string; line?: number }>>
    classMembers?: Record<string, Array<{ name?: string; line?: number }>>
    duplicates?: string[]
  }>
}

/**
 * Create violation for unused file
 */
function createUnusedFileViolation(file: string, cwd: string): CheckViolation {
  const filePath = file.startsWith('/') ? file : `${cwd}/${file}`
  const fileName = file.split('/').pop() ?? file
  return {
    line: 1,
    message: `Unused file: ${file}`,
    severity: 'warning',
    type: 'unused-file',
    suggestion: `Delete unused file '${fileName}' or add it to Knip's ignore configuration if intentionally kept`,
    match: fileName,
    filePath,
  }
}

/**
 * Process exports and types from a Knip issue
 */
function processExportsAndTypes(
  issue: NonNullable<KnipOutput['issues']>[number],
  filePath: string,
): CheckViolation[] {
  const violations: CheckViolation[] = []

  for (const exp of issue.exports ?? []) {
    const exportName = exp.symbol ?? exp.name ?? 'unknown'
    violations.push({
      line: exp.line ?? 1,
      message: `Unused export '${exportName}'`,
      severity: 'warning',
      type: 'unused-export',
      suggestion: `Remove unused export '${exportName}' or use it somewhere in the codebase`,
      match: exportName,
      filePath,
    })
  }

  for (const type of issue.types ?? []) {
    const typeName = type.symbol ?? type.name ?? 'unknown'
    violations.push({
      line: type.line ?? 1,
      message: `Unused type '${typeName}'`,
      severity: 'warning',
      type: 'unused-type',
      suggestion: `Remove unused type '${typeName}' or import it where needed`,
      match: typeName,
      filePath,
    })
  }

  return violations
}

/**
 * Process dependencies from a Knip issue
 */
function processDependencies(
  issue: NonNullable<KnipOutput['issues']>[number],
  filePath: string,
  _cwd: string,
): CheckViolation[] {
  const violations: CheckViolation[] = []

  for (const dep of [...(issue.dependencies ?? []), ...(issue.devDependencies ?? [])]) {
    const depName = dep.name ?? 'unknown'
    violations.push({
      line: dep.line ?? 1,
      message: `Unused dependency '${depName}'`,
      severity: 'warning',
      type: 'unused-dependency',
      suggestion: `Remove '${depName}' from package.json dependencies with 'pnpm remove ${depName}'`,
      match: depName,
      // Use the actual package.json path from Knip's issue, not the project root.
      // In a monorepo, each workspace has its own package.json — pointing to the
      // root masked which sub-package owned the unused dep.
      filePath,
    })
  }

  for (const dep of issue.unlisted ?? []) {
    const depName = dep.name ?? 'unknown'
    violations.push({
      line: dep.line ?? 1,
      message: `Unlisted dependency '${depName}'`,
      severity: 'error',
      suggestion: `Add '${depName}' to package.json: 'pnpm add ${depName}'`,
      type: 'unlisted-dependency',
      match: depName,
      filePath,
    })
  }

  return violations
}

/**
 * Process class and enum members from a Knip issue
 */
function processMembers(
  issue: NonNullable<KnipOutput['issues']>[number],
  filePath: string,
): CheckViolation[] {
  const violations: CheckViolation[] = []

  for (const [enumName, members] of Object.entries(issue.enumMembers ?? {})) {
    for (const member of members) {
      const memberName = member.name ?? 'unknown'
      violations.push({
        line: member.line ?? 1,
        message: `Unused enum member '${memberName}' in ${enumName}`,
        severity: 'warning',
        type: 'unused-enum-member',
        suggestion: `Remove unused enum member '${memberName}' from ${enumName} or use it in the codebase`,
        match: memberName,
        filePath,
      })
    }
  }

  for (const [className, members] of Object.entries(issue.classMembers ?? {})) {
    for (const member of members) {
      const memberName = member.name ?? 'unknown'
      violations.push({
        line: member.line ?? 1,
        message: `Unused class member '${memberName}' in ${className}`,
        severity: 'warning',
        type: 'unused-class-member',
        suggestion: `Remove unused method/property '${memberName}' from ${className} or make it public if it should be used externally`,
        match: memberName,
        filePath,
      })
    }
  }

  return violations
}

/**
 * Parse Knip JSON output into violations
 */
function parseKnipOutput(output: string, cwd: string): CheckViolation[] {
  const violations: CheckViolation[] = []
  const data: KnipOutput = JSON.parse(output)

  // Process unused files
  for (const file of data.files ?? []) {
    violations.push(createUnusedFileViolation(file, cwd))
  }

  // Process issues
  for (const issue of data.issues ?? []) {
    const filePath = issue.file.startsWith('/') ? issue.file : `${cwd}/${issue.file}`

    violations.push(...processExportsAndTypes(issue, filePath))
    violations.push(...processDependencies(issue, filePath, cwd))
    violations.push(...processMembers(issue, filePath))
  }

  return violations
}

/**
 * Check: quality/dead-code
 *
 * Uses Knip to detect unused code, exports, types, and dependencies.
 */
export const deadCode = defineCheck({
  id: '0ed970d8-0cfc-4263-b82d-c6e08e768a59',
  slug: 'dead-code',
  scope: { languages: ['typescript'], concerns: ['backend', 'frontend', 'cli'] },

  confidence: 'medium',
  description: 'Detect unused files, exports, types, and dependencies using Knip',
  longDescription: `**Purpose:** Detects dead code across the entire codebase by running the Knip static analysis tool and parsing its JSON output into fitness violations.

**Detects:** Runs external tool \`npx knip --reporter json\`.
- Unused files (no imports from anywhere)
- Unused exports and unused type exports
- Unused dependencies and devDependencies in package.json
- Unlisted dependencies (used but not declared in package.json)
- Unused enum members and class members

**Why it matters:** Dead code increases maintenance burden, slows builds, and confuses developers. Unlisted dependencies cause runtime failures in production.

**Scope:** General best practice`,
  tags: ['quality', 'dead-code', 'knip', 'maintainability'],
  fileTypes: ['ts'],
  timeout: 120_000, // 2 minutes - Knip workspace analysis can be slow

  command: {
    bin: 'npx',
    // Callable so config discovery runs at check execution time
    // (when process.cwd() is the project root), not at import time.
    args: (): readonly string[] => {
      const base = ['knip', '--reporter', 'json']
      const configPath = findKnipConfig(process.cwd())
      return configPath ? [...base, '--config', configPath] : base
    },
    expectedExitCodes: [0, 1], // 0 = no issues, 1 = issues found

    parseOutput(
      stdout: string,
      stderr: string,
      _exitCode: number,
      _files: readonly string[],
      cwd: string,
    ): CheckViolation[] {

      if (!stdout) {
        // No output - likely a configuration error
        return [
          {
            line: 1,
            message: `Knip failed: ${stderr || 'Unknown error'}`,
            severity: 'error',
            type: 'knip-error',
            suggestion:
              "Ensure Knip is installed and .config/knip.json exists. Run 'pnpm knip' manually for details",
            match: 'knip',
            filePath: cwd,
          },
        ]
      }

      try {
        return parseKnipOutput(stdout, cwd)
      } catch {
        // @swallow-ok If parsing fails, report the error
        return [
          {
            line: 1,
            message: `Failed to parse Knip output`,
            severity: 'error',
            type: 'knip-error',
            suggestion: "Run 'pnpm knip' manually to see detailed output",
            match: 'knip',
            filePath: cwd,
          },
        ]
      }
    },
  },
})
