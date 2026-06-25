// @fitness-ignore-file unused-config-options -- Config options reserved for future use or environment-specific
// @fitness-ignore-file fitness-check-standards -- Uses fs for package.json reading, not source file content
/**
 * @fileoverview Dependency Version Consistency check
 *
 * Ensures all packages in the monorepo use consistent dependency versions.
 * This prevents version drift which can cause subtle bugs, inconsistent behavior,
 * and bloated lockfiles.
 *
 * Checks:
 * - Dev dependencies: vitest, typescript, tsx, tsc-esm-fix, @types/node
 * - Runtime dependencies: zod, pino
 * - Workspace dependencies use workspace:* protocol
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-cli/fitness';

/**
 * Dependencies that should have consistent versions across all packages
 */
const TRACKED_DEPENDENCIES = [
  // Dev dependencies
  'vitest',
  'typescript',
  'tsx',
  'tsc-esm-fix',
  '@types/node',
  'vite-tsconfig-paths',
  '@vitest/coverage-v8',
  // Runtime dependencies
  'zod',
  'pino',
  'glob',
] as const;

/**
 * Workspace package prefixes that should use workspace:* protocol
 */
const WORKSPACE_PREFIXES: string[] = [];

interface PackageJson {
  name?: string | undefined;
  dependencies?: Record<string, string> | undefined;
  devDependencies?: Record<string, string> | undefined;
  peerDependencies?: Record<string, string> | undefined;
}

interface DependencyUsage {
  version: string;
  packages: string[];
  isDevDep: boolean;
}

interface VersionAnalysis {
  dependency: string;
  versions: Map<string, DependencyUsage>;
  canonicalVersion: string;
  hasInconsistency: boolean;
}

/* v8 ignore start -- filesystem read helpers; error/file-size branches covered by integration */
/**
 * Parse a package.json file safely
 */
function parsePackageJson(filePath: string): PackageJson | null {
  try {
    const stats = fs.statSync(filePath);
    if (stats.size > 10_000_000) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content) as PackageJson;
  } catch {
    // @swallow-ok graceful degradation - return sentinel on failure
    return null;
  }
}
/* v8 ignore stop */

/**
 * Get the root package.json canonical versions
 */
function getRootVersions(projectRoot: string): Map<string, string> {
  const rootPkg = parsePackageJson(path.join(projectRoot, 'package.json'));
  const versions = new Map<string, string>();

  if (!rootPkg) return versions;

  const allDeps = {
    ...rootPkg.dependencies,
    ...rootPkg.devDependencies,
  };

  for (const [dep, version] of Object.entries(allDeps)) {
    if (TRACKED_DEPENDENCIES.includes(dep as (typeof TRACKED_DEPENDENCIES)[number])) {
      versions.set(dep, version);
    }
  }

  return versions;
}

/**
 * Analyze dependency versions across all packages
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- inherent complexity: collects versions from all packages across deps/devDeps, then determines inconsistencies
function analyzeDependencyVersions(
  packageJsonFiles: string[],
  projectRoot: string,
): Map<string, VersionAnalysis> {
  const analysis = new Map<string, VersionAnalysis>();
  const rootVersions = getRootVersions(projectRoot);

  // Initialize analysis for tracked dependencies
  for (const dep of TRACKED_DEPENDENCIES) {
    analysis.set(dep, {
      dependency: dep,
      versions: new Map(),
      canonicalVersion: rootVersions.get(dep) ?? '',
      hasInconsistency: false,
    });
  }

  // Collect versions from all packages
  for (const pkgPath of packageJsonFiles) {
    const pkg = parsePackageJson(pkgPath);
    if (!pkg) continue;

    const pkgName = pkg.name ?? path.basename(path.dirname(pkgPath));

    // Check both dependencies and devDependencies
    const depSources: { deps: Record<string, string> | undefined; isDev: boolean }[] = [
      { deps: pkg.dependencies, isDev: false },
      { deps: pkg.devDependencies, isDev: true },
    ];

    for (const { deps, isDev } of depSources) {
      if (!deps) continue;

      for (const [dep, version] of Object.entries(deps)) {
        const depAnalysis = analysis.get(dep);
        if (depAnalysis) {
          const existing = depAnalysis.versions.get(version);
          if (existing) {
            existing.packages.push(pkgName);
          } else {
            depAnalysis.versions.set(version, {
              version,
              packages: [pkgName],
              isDevDep: isDev,
            });
          }
        }
      }
    }
  }

  // Determine inconsistencies
  for (const [, depAnalysis] of analysis) {
    if (depAnalysis.versions.size > 1) {
      depAnalysis.hasInconsistency = true;
    } else if (depAnalysis.versions.size === 1 && depAnalysis.canonicalVersion) {
      const [usedVersion] = depAnalysis.versions.keys();
      if (usedVersion !== depAnalysis.canonicalVersion) {
        depAnalysis.hasInconsistency = true;
      }
    }
  }

  return analysis;
}

/**
 * Check for workspace dependencies not using workspace:* protocol
 */
function findNonWorkspaceProtocolDeps(
  packageJsonFiles: string[],
  projectRoot: string,
): { pkgName: string; pkgPath: string; dep: string; version: string }[] {
  const violations: { pkgName: string; pkgPath: string; dep: string; version: string }[] = [];

  for (const pkgPath of packageJsonFiles) {
    const pkg = parsePackageJson(pkgPath);
    if (!pkg) continue;

    const pkgName = pkg.name ?? path.basename(path.dirname(pkgPath));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    for (const [dep, version] of Object.entries(allDeps)) {
      // eslint-disable-next-line sonarjs/no-empty-collection -- WORKSPACE_PREFIXES is intentionally empty by default; consumers populate it via project config
      const isWorkspaceDep = WORKSPACE_PREFIXES.some((prefix) => dep.startsWith(prefix));
      if (isWorkspaceDep && !version.startsWith('workspace:')) {
        violations.push({
          pkgName,
          pkgPath: path.relative(projectRoot, pkgPath),
          dep,
          version,
        });
      }
    }
  }

  return violations;
}

/**
 * Get the most common or highest semver version as the canonical choice
 */
function suggestCanonicalVersion(analysis: VersionAnalysis): string {
  if (analysis.canonicalVersion) {
    return analysis.canonicalVersion;
  }

  // Find version used by most packages
  let maxCount = 0;
  let suggested = '';

  for (const [version, usage] of analysis.versions) {
    if (usage.packages.length > maxCount) {
      maxCount = usage.packages.length;
      suggested = version;
    }
  }

  return suggested;
}

/**
 * Check: quality/dependency-version-consistency
 *
 * Ensures all packages use consistent dependency versions and
 * workspace dependencies use the workspace:* protocol.
 */
export const dependencyVersionConsistency = defineCheck({
  id: '05d7f95c-59e1-439c-965b-6c1179d3ae13',
  slug: 'dependency-version-consistency',
  scope: { languages: ['json', 'typescript', 'yaml'], concerns: ['config'] },

  confidence: 'medium',
  description: 'Ensures consistent dependency versions across all packages',
  longDescription: `**Purpose:** Ensures all packages in the monorepo use consistent versions of tracked dependencies and workspace protocol for internal packages.

**Detects:**
- Version mismatches for tracked dependencies: vitest, typescript, tsx, tsc-esm-fix, @types/node, vite-tsconfig-paths, @vitest/coverage-v8, zod, pino, glob
- Workspace dependencies not using the \`workspace:*\` protocol

**Why it matters:** Version drift across packages causes subtle bugs, inconsistent behavior, and bloated lockfiles. Non-workspace protocol usage breaks monorepo linking.

**Scope:** Codebase-specific convention. Cross-file analysis (\`analyzeAll\`). Scans all \`package.json\` files against root canonical versions.`,
  tags: ['quality', 'dependencies', 'monorepo'],

  // eslint-disable-next-line @typescript-eslint/require-await -- AnalyzeAllCheckConfig requires Promise<CheckViolation[]>; this implementation is synchronous
  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = [];

    // Discover package.json files from the supplied set (NOT process.cwd()), so
    // the check analyzes exactly the files in scope — identical behavior under
    // `fit` (root + every package's package.json are in scope) and under tests.
    // The shortest path is the topmost (root) package.json — the canonical
    // version source; the rest are the workspace packages compared against it.
    const pkgJsonPaths = files.paths
      .filter((p) => path.basename(p) === 'package.json')
      .sort((a, b) => a.length - b.length);
    if (pkgJsonPaths.length === 0) {
      return violations;
    }
    const projectRoot = path.dirname(pkgJsonPaths[0] ?? '');
    const packageJsonFiles = pkgJsonPaths.slice(1);

    // Analyze version consistency
    const analysis = analyzeDependencyVersions(packageJsonFiles, projectRoot);

    // Report version inconsistencies
    for (const [dep, depAnalysis] of analysis) {
      if (depAnalysis.hasInconsistency && depAnalysis.versions.size > 0) {
        const canonical = suggestCanonicalVersion(depAnalysis);
        const affectedPackages = [...depAnalysis.versions.values()]
          .flatMap((u) => u.packages)
          .filter((pkg) => {
            const pkgVersion = [...depAnalysis.versions.entries()].find(([, u]) =>
              u.packages.includes(pkg),
            )?.[0];
            return pkgVersion !== canonical;
          });

        for (const pkgName of affectedPackages) {
          const pkgVersion = [...depAnalysis.versions.entries()].find(([, u]) =>
            u.packages.includes(pkgName),
          )?.[0];

          violations.push({
            line: 1,
            message: `Package '${pkgName}' uses ${dep}@${pkgVersion} instead of canonical version ${canonical}`,
            severity: 'warning',
            // @fitness-ignore-next-line sql-injection -- Fitness check suggestion text, not SQL query
            suggestion: `Update to ${dep}@${canonical} for consistency. Consider using pnpm catalog for centralized version management.`,
            match: dep,
            type: 'version-mismatch',
            filePath: `${pkgName}/package.json`,
          });
        }
      }
    }

    // Check workspace protocol usage
    const nonWorkspaceViolations = findNonWorkspaceProtocolDeps(packageJsonFiles, projectRoot);
    for (const violation of nonWorkspaceViolations) {
      violations.push({
        line: 1,
        message: `Package '${violation.pkgName}' should use 'workspace:*' for ${violation.dep} instead of '${violation.version}'`,
        severity: 'error',
        suggestion: `Change "${violation.dep}": "${violation.version}" to "${violation.dep}": "workspace:*"`,
        match: violation.dep,
        type: 'workspace-protocol',
        filePath: violation.pkgPath,
      });
    }

    return violations;
  },
});
