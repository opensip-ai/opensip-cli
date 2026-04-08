// @fitness-ignore-file fitness-check-standards -- Uses fs for directory listing/stat operations, not file content reading
/**
 * @fileoverview No Duplicate Packages check (v2)
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/core'

interface PackageInfo {
  name: string
  path: string
  keywords?: string[]
}

interface DuplicateGroup {
  category: string
  reason: string
  packages: PackageInfo[]
  severity: 'error' | 'warning'
}

interface DuplicatePattern {
  category: string
  namePatterns: RegExp[]
  minForWarning: number
  minForError: number
  reason: string
}

const DUPLICATE_PATTERNS: DuplicatePattern[] = [
  {
    category: 'contracts/types',
    namePatterns: [/contracts?$/, /types?$/, /shared-types?$/, /common-types?$/],
    minForWarning: 2,
    minForError: 3,
    reason: 'Multiple type definition packages cause confusion',
  },
  {
    category: 'utilities',
    namePatterns: [/utils?$/, /helpers?$/, /common$/, /shared$/],
    minForWarning: 2,
    minForError: 3,
    reason: 'Multiple utility packages lead to scattered helper functions',
  },
  {
    category: 'api-client',
    namePatterns: [/api-client$/, /http-client$/, /-client$/],
    minForWarning: 2,
    minForError: 3,
    reason: 'Multiple API clients create inconsistent data fetching patterns',
  },
  {
    category: 'config',
    namePatterns: [/config$/, /configuration$/, /settings$/],
    minForWarning: 2,
    minForError: 3,
    reason: 'Multiple configuration packages scatter environment setup',
  },
  {
    category: 'logging',
    namePatterns: [/logger$/, /logging$/, /log$/],
    minForWarning: 2,
    minForError: 2,
    reason: 'Multiple logging packages lead to inconsistent log formats',
  },
]

const EXCLUDED_PACKAGES = [/__fixtures__/, /__mocks__/, /examples?$/, /-test$/, /-mock$/]

function getPackageInfo(packageJsonPath: string, projectRoot: string): PackageInfo | null {
  try {
    const content = fs.readFileSync(packageJsonPath, 'utf-8')
    const pkg = JSON.parse(content)
    const packageDir = path.dirname(packageJsonPath)
    const relativePath = path.relative(projectRoot, packageDir)

    if (EXCLUDED_PACKAGES.some((p) => p.test(relativePath))) {
      return null
    }

    return {
      name: pkg.name || path.basename(packageDir),
      path: relativePath,
      keywords: pkg.keywords,
    }
  } catch {
    // @swallow-ok graceful degradation - return sentinel on failure
    return null
  }
}

function matchesPattern(pkg: PackageInfo, patterns: RegExp[]): boolean {
  // Validate array parameter
  if (!Array.isArray(patterns)) {
    return false
  }

  const namePart = pkg.name.split('/').pop() || pkg.name
  if (patterns.some((p) => p.test(namePart))) return true
  if (pkg.keywords) {
    for (const keyword of pkg.keywords) {
      if (patterns.some((p) => p.test(keyword))) return true
    }
  }
  return false
}

/** Deduplicate packages by their unscoped name part to avoid counting @scope/foo and foo as separate entries */
function deduplicateByNamePart(packages: PackageInfo[]): PackageInfo[] {
  const seen = new Map<string, PackageInfo>()
  for (const pkg of packages) {
    const namePart = pkg.name.split('/').pop() || pkg.name
    if (!seen.has(namePart)) {
      seen.set(namePart, pkg)
    }
  }
  return [...seen.values()]
}

function detectDuplicates(packages: PackageInfo[]): DuplicateGroup[] {
  // Validate array parameter
  if (!Array.isArray(packages)) {
    return []
  }

  const groups: DuplicateGroup[] = []

  for (const pattern of DUPLICATE_PATTERNS) {
    const matching = deduplicateByNamePart(packages.filter((pkg) => matchesPattern(pkg, pattern.namePatterns)))
    if (matching.length >= pattern.minForWarning) {
      groups.push({
        category: pattern.category,
        reason: pattern.reason,
        packages: matching,
        severity: matching.length >= pattern.minForError ? 'error' : 'warning',
      })
    }
  }

  return groups
}

/**
 * Check: architecture/no-duplicate-packages
 *
 * Detects packages that serve the same purpose or have overlapping functionality.
 * This prevents confusion about which package to use and unnecessary duplication.
 */
export const noDuplicatePackages = defineCheck({
  id: '06c7c267-c5a6-4386-81ab-88ddc2c4f5a4',
  slug: 'no-duplicate-packages',
  tags: ['architecture'],
  scope: { languages: ['json', 'typescript', 'yaml'], concerns: ['config'] },
  contentFilter: 'code-only',

  confidence: 'medium',
  description: 'Detects packages that serve the same purpose',
  longDescription: `**Purpose:** Detects multiple packages in the monorepo that serve the same functional purpose, preventing fragmentation of shared concerns.

**Detects:**
- Package names or keywords matching duplicate-prone categories: contracts/types (\`/contracts?$/\`, \`/types?$/\`), utilities (\`/utils?$/\`, \`/helpers?$/\`), api-client (\`/api-client$/\`, \`/-client$/\`), config (\`/config$/\`, \`/settings$/\`), logging (\`/logger$/\`, \`/logging$/\`)
- Warns at 2+ matches per category; errors at 3+ (logging errors at 2+)

**Why it matters:** Duplicate packages create confusion about which to use, scatter related logic, and lead to inconsistent patterns across the codebase.

**Scope:** General best practice. Cross-file analysis over all \`packages/**/package.json\` files.`,
  fileTypes: ['json'],

  // @fitness-ignore-next-line concurrency-safety -- async keyword required by analyzeAll interface contract; synchronous analysis implementation
  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    // Get the cwd from the first file path
    const firstFile = files.paths[0]
    const cwd = firstFile ? path.dirname(path.dirname(path.dirname(firstFile))) : process.cwd()

    const packages: PackageInfo[] = []

    for (const packageJsonPath of files.paths) {
      const info = getPackageInfo(packageJsonPath, cwd)
      if (info) packages.push(info)
    }

    const duplicateGroups = detectDuplicates(packages)
    const violations: CheckViolation[] = []

    for (const group of duplicateGroups) {
      const packageNames = group.packages.map((p) => p.name)
      const firstPath = group.packages[0]?.path || 'packages'

      violations.push({
        filePath: path.join(cwd, firstPath, 'package.json'),
        line: 1,
        message: `Duplicate ${group.category} packages: ${packageNames.join(', ')}. ${group.reason}`,
        severity: group.severity,
        suggestion: `Consolidate ${group.category} packages into a single canonical package. Remove duplicates and update all consumers to use the canonical package.`,
        match: group.category,
        type: 'duplicate-package',
      })
    }

    return violations
  },
})
