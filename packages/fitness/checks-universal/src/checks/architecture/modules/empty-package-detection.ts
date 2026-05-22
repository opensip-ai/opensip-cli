// @fitness-ignore-file fitness-check-standards -- Uses fs for directory listing/stat operations, not file content reading
// @fitness-ignore-file file-length-limits -- Complex module with tightly coupled logic; refactoring would risk breaking changes
/**
 * @fileoverview Empty Package Detection check
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness'

const MIN_EXPORTS_THRESHOLD = 1
const COMMENTED_EXPORT_RATIO_THRESHOLD = 0.5

const EXCLUDED_PACKAGES = [/__fixtures__/, /__mocks__/, /examples?\//, /^apps\//]

interface PackageInfo {
  name: string
  packagePath: string
  mainEntry: string
  exportCount: number
  commentedExportCount: number
  isEmpty: boolean
  reason?: string | undefined
}

/* v8 ignore start -- entry resolution depends on filesystem layout; many fallback branches covered by integration */
/**
 * Try to resolve a path, checking both .js and .ts extensions
 */
function resolveEntryPath(basePath: string): string | null {
  if (fs.existsSync(basePath)) {
    return basePath
  }

  const tsPath = basePath.replace(/\.js$/, '.ts')
  if (fs.existsSync(tsPath)) {
    return tsPath
  }

  return null
}

/**
 * Try to find the main entry from package.json main/module/exports['.']
 */
function resolveMainEntry(packageDir: string, main: string): string | null {
  const mainPath = path.join(packageDir, main)
  const resolved = resolveEntryPath(mainPath)
  if (resolved) {
    return resolved
  }

  // Try index.ts in the main directory
  const indexPath = path.join(path.dirname(mainPath), 'index.ts')
  if (fs.existsSync(indexPath)) {
    return indexPath
  }

  return null
}

/**
 * Try to find entry from subpath exports
 */
function resolveSubpathExports(
  exports: Record<string, unknown>,
  packageDir: string,
): string | null {
  const exportEntry = Object.keys(exports).find((k) => k !== '.')
  const firstKey = exportEntry
  if (firstKey === undefined) {
    return null
  }

  const firstExport = exports[firstKey]
  if (typeof firstExport === 'string') {
    const resolved = resolveEntryPath(path.join(packageDir, firstExport))
    if (resolved) {
      return resolved
    }
  }

  return 'has-subpath-exports'
}

function getMainEntryFile(packageJsonPath: string): string | null {
  try {
    const content = fs.readFileSync(packageJsonPath, 'utf8')
    const pkg = JSON.parse(content) as Record<string, unknown>
    const packageDir = path.dirname(packageJsonPath)

    // Check main, exports['.'], or module
    const pkgExports = pkg.exports as Record<string, unknown> | undefined
    const main =
      (pkg.main as string) ||
      (pkgExports?.['.' as keyof typeof pkgExports] as string) ||
      (pkg.module as string)

    if (main) {
      const resolved = resolveMainEntry(packageDir, main)
      if (resolved) {
        return resolved
      }
    }

    // Check subpath exports
    if (pkgExports && typeof pkgExports === 'object') {
      return resolveSubpathExports(pkgExports, packageDir)
    }

    return null
  } catch {
    // @swallow-ok graceful degradation - return sentinel on failure
    return null
  }
}
/* v8 ignore stop */

/* v8 ignore start -- barrel-file analysis with multiple export-prefix branches; covered indirectly */
function analyzeBarrelFile(filePath: string): {
  exportCount: number
  commentedExportCount: number
} {
  if (filePath === 'has-subpath-exports') {
    return { exportCount: 1, commentedExportCount: 0 }
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const lines = content.split('\n')

    let exportCount = 0
    let commentedExportCount = 0

    for (const line of lines) {
      const trimmed = line.trim()

      if (
        trimmed.startsWith('export ') ||
        trimmed.startsWith('export type {') ||
        trimmed.startsWith('export {') ||
        trimmed.startsWith('export *')
      ) {
        exportCount++
      }

      if (trimmed.startsWith('// export ') || trimmed.startsWith('// export*')) {
        commentedExportCount++
      }
    }

    return { exportCount, commentedExportCount }
  } catch {
    return { exportCount: 0, commentedExportCount: 0 }
  }
}
/* v8 ignore stop */

/**
 * Determine the reason why a package is considered problematic
 */
function determinePackageReason(
  isEmpty: boolean,
  hasHighCommentedRatio: boolean,
  exportCount: number,
  commentedExportCount: number,
): string | undefined {
  if (isEmpty) {
    return `Only ${exportCount} export(s), minimum is ${MIN_EXPORTS_THRESHOLD}`
  }
  if (hasHighCommentedRatio) {
    return `${commentedExportCount} commented exports vs ${exportCount} active (>50% commented)`
  }
  return undefined
}

/* v8 ignore start -- package analysis has many filesystem-dependent branches; covered indirectly */
function analyzePackage(packageJsonPath: string, projectRoot: string): PackageInfo | null {
  try {
    const content = fs.readFileSync(packageJsonPath, 'utf8')
    const pkg = JSON.parse(content) as { name?: string; bin?: unknown }
    const packageDir = path.dirname(packageJsonPath)
    const relativePath = path.relative(projectRoot, packageDir)

    if (EXCLUDED_PACKAGES.some((pattern) => pattern.test(relativePath))) {
      return null
    }

    // Skip app packages that are not meant to be consumed as libraries
    // (e.g. CLI binaries, web apps with no main/exports)
    if (pkg.bin) {
      return null
    }

    const mainEntry = getMainEntryFile(packageJsonPath)
    if (!mainEntry) {
      // Skip packages under apps/ that have no library entry point
      // (e.g. dashboard is a web app built with Vite, not a library)
      if (relativePath.startsWith('apps/') || relativePath.startsWith('apps\\')) {
        return null
      }
      return {
        name: pkg.name ?? path.basename(packageDir),
        packagePath: relativePath,
        mainEntry: 'not found',
        exportCount: 0,
        commentedExportCount: 0,
        isEmpty: true,
        reason: 'No main entry file found',
      }
    }

    const { exportCount, commentedExportCount } = analyzeBarrelFile(mainEntry)
    const relativeMainEntry = path.relative(projectRoot, mainEntry)

    const isEmpty = exportCount < MIN_EXPORTS_THRESHOLD
    const hasHighCommentedRatio =
      commentedExportCount > 0 &&
      exportCount > 0 &&
      commentedExportCount / (exportCount + commentedExportCount) > COMMENTED_EXPORT_RATIO_THRESHOLD

    // Determine reason if package is problematic
    const reason = determinePackageReason(
      isEmpty,
      hasHighCommentedRatio,
      exportCount,
      commentedExportCount,
    )

    return {
      name: pkg.name ?? path.basename(packageDir),
      packagePath: relativePath,
      mainEntry: relativeMainEntry,
      exportCount,
      commentedExportCount,
      isEmpty: isEmpty || hasHighCommentedRatio,
      reason,
    }
  } catch {
    // @swallow-ok graceful degradation - return sentinel on failure
    return null
  }
}
/* v8 ignore stop */

/**
 * Get the entry path for a package
 */
function getPackageEntryPath(pkg: PackageInfo, cwd: string): string {
  if (pkg.mainEntry !== 'not found') {
    return path.join(cwd, pkg.mainEntry)
  }
  return path.join(cwd, pkg.packagePath, 'package.json')
}

/**
 * Get suggestion text based on export count
 */
function getPackageSuggestion(exportCount: number): string {
  if (exportCount === 0) {
    return `Add exports to the package barrel file (index.ts) or remove the package if it's no longer needed.`
  }
  return `Uncomment valid exports or remove the commented export statements if they're no longer needed.`
}

/**
 * Create a violation for an empty package
 */
function createPackageViolation(pkg: PackageInfo, cwd: string): CheckViolation {
  const entryPath = getPackageEntryPath(pkg, cwd)
  const suggestion = getPackageSuggestion(pkg.exportCount)

  return {
    filePath: entryPath,
    line: 1,
    message: `Package '${pkg.name}' appears empty or has mostly commented exports. ${pkg.reason ?? ''}`,
    severity: pkg.exportCount === 0 ? 'error' : 'warning',
    suggestion,
    match: pkg.name,
    type: pkg.exportCount === 0 ? 'empty-package' : 'mostly-commented',
  }
}

/**
 * Check: architecture/empty-package-detection
 *
 * Detects packages with empty or commented-out exports in their barrel files.
 * This prevents dead packages from accumulating in the monorepo.
 */
export const emptyPackageDetection = defineCheck({
  id: '8759e76a-3e1f-48e2-9678-6304fed7a057',
  slug: 'empty-package-detection',
  itemType: 'packages',
  scope: { languages: ['json', 'typescript', 'yaml'], concerns: ['config'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Detects packages with empty or commented-out exports',
  longDescription: `**Purpose:** Ensures every package in the monorepo has meaningful exports in its barrel file, preventing dead packages from accumulating.

**Detects:**
- Packages whose barrel file (index.ts) has fewer than ${MIN_EXPORTS_THRESHOLD} \`export\` statement (lines starting with \`export \`, \`export type {\`, \`export {\`, or \`export *\`)
- Packages where more than 50% of export statements are commented out (\`// export \`)
- Packages with no resolvable main entry file (checked via \`main\`, \`exports["."]\`, or \`module\` in package.json)

**Why it matters:** Empty or mostly-commented packages add build overhead, confuse dependency graphs, and signal abandoned code that should be cleaned up.

**Scope:** Codebase-specific convention. Cross-file analysis via \`analyzeAll\` over all \`packages/**/package.json\` files.`,
  tags: ['architecture', 'maintainability'],
  fileTypes: ['json'],

  // @fitness-ignore-next-line concurrency-safety -- async keyword required by analyzeAll interface contract; synchronous analysis implementation
  // eslint-disable-next-line @typescript-eslint/require-await -- AnalyzeAllCheckConfig requires Promise<CheckViolation[]>; this implementation is synchronous
  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const cwd = process.cwd()

    // Only process package.json files, not tsconfig.json or other JSON
    const packageJsonPaths = files.paths.filter((p) => path.basename(p) === 'package.json')

    const packages: PackageInfo[] = []

    for (const packageJsonPath of packageJsonPaths) {
      // Skip root workspace package.json (not a library package)
      const relPath = path.relative(cwd, packageJsonPath)
      if (relPath === 'package.json') continue

      const info = analyzePackage(packageJsonPath, cwd)
      if (info) packages.push(info)
    }

    const violations: CheckViolation[] = []
    const emptyPackages = packages.filter((pkg) => pkg.isEmpty)

    for (const pkg of emptyPackages) {
      violations.push(createPackageViolation(pkg, cwd))
    }

    return violations
  },
})
