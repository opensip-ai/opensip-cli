// @fitness-ignore-file fitness-check-standards -- Uses fs for directory walking / file existence, not source file content
/**
 * @fileoverview Vitest config required with tests check
 *
 * Ensures every workspace package that contains test files
 * (`*.test.ts` / `*.test.tsx`) ships a `vitest.config.ts` (or
 * `vitest.config.mts`) at its package root — unless the workspace root
 * centralizes a vitest config.
 *
 * Rationale: in a monorepo each package commonly owns its own
 * `vitest.config.ts` carrying per-package coverage thresholds. A package
 * that accrues tests but no config runs config-less with no coverage
 * floor, letting coverage silently drift. This check catches that drift.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-cli/fitness';

/** Per-package vitest config filenames that satisfy the requirement. */
const PACKAGE_CONFIG_FILES = ['vitest.config.ts', 'vitest.config.mts'] as const;

/**
 * Workspace-root config filenames that, when present, satisfy the
 * requirement for ALL packages (a repo may centralize vitest config).
 */
const WORKSPACE_CONFIG_FILES = [
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.workspace.ts',
] as const;

/** Directory names never descended into when scanning for test files. */
const SKIP_DIRS = new Set([
  'node_modules',
  '__fixtures__',
  '__mocks__',
  'fixtures',
  'dist',
  'build',
  'coverage',
  '.git',
]);

/**
 * Filesystem port. Injected so the pure detector can be unit-tested
 * without touching the real disk.
 */
export interface VitestConfigFsPort {
  /** True if `filePath` exists. */
  exists(filePath: string): boolean;
  /**
   * True if at least one `*.test.ts` / `*.test.tsx` file exists anywhere
   * under `packageDir` (excluding nested package roots, node_modules,
   * fixtures, and build output).
   */
  hasTestFiles(packageDir: string): boolean;
}

/** Is this filename a test file we care about? */
function isTestFile(name: string): boolean {
  return name.endsWith('.test.ts') || name.endsWith('.test.tsx');
}

/** Read directory entries, returning `null` when the directory is unreadable. */
function readEntries(dir: string): fs.Dirent[] | null {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // @swallow-ok unreadable directory -> treat as no tests
    return null;
  }
}

/** True if a directory entry is a subdirectory we should descend into. */
function isDescendableDir(entry: fs.Dirent): boolean {
  return entry.isDirectory() && !SKIP_DIRS.has(entry.name);
}

/**
 * Recursively search `dir` for a test file, stopping at the first hit.
 * Does NOT descend into nested package roots (a dir containing its own
 * `package.json`) so a parent package isn't blamed for a child's tests,
 * nor into skip dirs (node_modules, fixtures, build output).
 */
function hasTestFilesIn(dir: string, isRoot: boolean): boolean {
  const entries = readEntries(dir);
  if (entries === null) return false;

  // A nested package root owns its own tests; don't count them here.
  const isNestedPackageRoot =
    !isRoot && entries.some((e) => e.isFile() && e.name === 'package.json');
  if (isNestedPackageRoot) return false;

  if (entries.some((e) => e.isFile() && isTestFile(e.name))) return true;

  return entries
    .filter(isDescendableDir)
    .some((e) => hasTestFilesIn(path.join(dir, e.name), false));
}

/** Default filesystem port backed by `node:fs`. */
export const nodeFsPort: VitestConfigFsPort = {
  exists: (filePath) => fs.existsSync(filePath),
  hasTestFiles: (packageDir) => hasTestFilesIn(packageDir, true),
};

/**
 * The directory shared by every input path. For a single path this is its
 * own directory. Used to locate the workspace-root region without relying
 * on `process.cwd()` (which, under the in-process test harness, points at
 * the runner's directory, not the project being analyzed).
 */
function commonAncestorDir(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const segmentLists = paths.map((p) => path.dirname(p).split(path.sep));
  const [first, ...rest] = segmentLists;
  if (!first) return null;

  const common: string[] = [];
  for (const [index, seg] of first.entries()) {
    if (!rest.every((segs) => segs[index] === seg)) break;
    common.push(seg);
  }

  const joined = common.join(path.sep);
  return joined === '' ? path.sep : joined;
}

/**
 * Candidate workspace-root directories: the common ancestor of all package
 * roots, plus its immediate parent (covering both a flat root and the
 * common `packages/*` layout where the centralized config sits one level
 * above the shared `packages/` ancestor).
 */
function workspaceRootCandidates(packageDirs: readonly string[]): string[] {
  const ancestor = commonAncestorDir(packageDirs.map((d) => path.join(d, 'x')));
  if (ancestor === null) return [];
  const parent = path.dirname(ancestor);
  return parent === ancestor ? [ancestor] : [ancestor, parent];
}

/**
 * Pure detector. Given the discovered package-root `package.json` paths and
 * a filesystem port, returns one violation per package that has tests but no
 * satisfying vitest config.
 *
 * A package is satisfied if it has a per-package config OR a centralized
 * config exists at the workspace root (the common ancestor of all package
 * roots, or one level above it).
 */
export function detectMissingVitestConfig(
  packageJsonPaths: readonly string[],
  port: VitestConfigFsPort,
): CheckViolation[] {
  const packageDirs = packageJsonPaths.map((p) => path.dirname(p));

  // A centralized workspace-root config satisfies every package.
  const rootCandidates = workspaceRootCandidates(packageDirs);
  const workspaceConfigSatisfies = rootCandidates.some((root) =>
    WORKSPACE_CONFIG_FILES.some((f) => port.exists(path.join(root, f))),
  );
  if (workspaceConfigSatisfies) {
    return [];
  }

  const violations: CheckViolation[] = [];
  const rootSet = new Set(rootCandidates.map((r) => path.resolve(r)));

  for (const packageJsonPath of packageJsonPaths) {
    const packageDir = path.dirname(packageJsonPath);

    // Skip a workspace-root package.json — it is not a leaf package, and the
    // centralized-config branch above already covered its only satisfy path.
    // (Only meaningful when there are multiple packages; with a single
    // package its dir IS the ancestor and we must still evaluate it.)
    if (packageDirs.length > 1 && rootSet.has(path.resolve(packageDir))) {
      continue;
    }

    if (!port.hasTestFiles(packageDir)) {
      continue;
    }

    const hasPackageConfig = PACKAGE_CONFIG_FILES.some((f) =>
      port.exists(path.join(packageDir, f)),
    );
    if (hasPackageConfig) {
      continue;
    }

    violations.push({
      filePath: packageJsonPath,
      line: 1,
      message: `Package '${path.basename(packageDir)}' contains test files but has no vitest.config.ts at its package root`,
      severity: 'error',
      suggestion:
        'Add a vitest.config.ts (or vitest.config.mts) at the package root with explicit coverage thresholds, or centralize one at the workspace root. Without it, tests run config-less with no coverage floor and coverage can silently drift.',
      match: path.basename(packageDir),
      type: 'missing-vitest-config',
    });
  }

  return violations;
}

/**
 * Check: architecture/vitest-config-required-with-tests
 *
 * Every workspace package that contains test files must ship a
 * `vitest.config.ts` (or `.mts`) at its package root, unless the
 * workspace root centralizes a vitest config.
 */
export const vitestConfigRequiredWithTests = defineCheck({
  id: 'b7363db9-c3f7-47bc-8c25-1ddeebf53904',
  slug: 'vitest-config-required-with-tests',
  itemType: 'packages',
  scope: {
    languages: ['typescript'],
    concerns: ['backend', 'frontend', 'cli'],
  },

  confidence: 'high',
  description: 'Ensures packages with tests have a vitest.config at the package root',
  longDescription: `**Purpose:** Ensures every workspace package that contains test files (\`*.test.ts\` / \`*.test.tsx\`) ships a \`vitest.config.ts\` (or \`vitest.config.mts\`) at its package root, so per-package coverage thresholds are actually applied.

**Detects:**
- A package root (a directory containing a \`package.json\`) that has at least one \`*.test.ts\` / \`*.test.tsx\` file anywhere beneath it, but no \`vitest.config.ts\` / \`vitest.config.mts\` at the package root.

**Satisfied by:**
- A per-package \`vitest.config.ts\` / \`vitest.config.mts\` at the package root, OR
- A centralized \`vitest.config.ts\` / \`vitest.config.mts\` / \`vitest.workspace.ts\` at the workspace root (a repo may centralize config).

**Why it matters:** When a package accrues tests but has no vitest config, its tests run config-less with no per-package coverage floor — letting coverage silently drift. This is a portable, package-name-agnostic structural check.

**Scope:** Cross-file analysis via \`analyzeAll\`. Package roots are discovered generically from \`package.json\` files; nested package roots, \`node_modules\`, fixtures, and build output are skipped when scanning for tests.`,
  tags: ['architecture', 'testing'],

  // eslint-disable-next-line @typescript-eslint/require-await -- AnalyzeAllCheckConfig requires Promise<CheckViolation[]>; this implementation is synchronous
  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const packageJsonPaths = files.paths.filter((fp) => path.basename(fp) === 'package.json');
    return detectMissingVitestConfig(packageJsonPaths, nodeFsPort);
  },
});
