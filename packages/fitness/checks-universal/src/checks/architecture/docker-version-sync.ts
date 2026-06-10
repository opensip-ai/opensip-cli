// @fitness-ignore-file fitness-check-standards -- Uses fs for package.json reading, not source file content
// @fitness-ignore-file duplicate-implementation-detection -- similar patterns across diagnostic modules
/**
 * @fileoverview Docker version sync fitness check
 * @invariants
 * - Node major version in FROM directives must match engines.node from root package.json
 * - pnpm version should be derived dynamically from package.json packageManager field
 * - Hardcoded pnpm versions that don't match packageManager are errors
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness';

// =============================================================================
// TYPES
// =============================================================================

interface RootPackageJson {
  packageManager?: string;
  engines?: {
    node?: string;
  };
}

// =============================================================================
// REGEX PATTERNS
// =============================================================================

/** Matches FROM node:XX or FROM node:XX-alpine etc. */
const FROM_NODE_PATTERN = /^FROM\s+node:(\d+)/i;

/** Matches corepack prepare pnpm@X.Y.Z or pnpm@X */
const PNPM_HARDCODED_PATTERN = /corepack\s+prepare\s+pnpm@([\d.]+)/;

/** Matches the dynamic self-read pattern */
const PNPM_DYNAMIC_PATTERN = /require\(['"]\.\/package\.json['"]\)\.packageManager/;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Read and parse root package.json.
 * @throws {Error} When the file exceeds 10MB
 */
function readRootPackageJson(cwd: string): RootPackageJson {
  const pkgPath = path.join(cwd, 'package.json');
  const stats = fs.statSync(pkgPath);
  if (stats.size > 10_000_000) throw new Error(`File too large: ${pkgPath}`);
  const raw = fs.readFileSync(pkgPath, 'utf8');
  return JSON.parse(raw) as RootPackageJson;
}

/**
 * Extract major Node version from engines.node constraint.
 * e.g. ">=20.0.0" → 20
 */
function extractNodeMajor(constraint: string): number | null {
  const match = /(\d+)/.exec(constraint);
  const digit = match?.[1];
  // @fitness-ignore-next-line numeric-validation -- regex (\d+) guarantees digit-only string
  return digit ? Number.parseInt(digit, 10) : null;
}

/**
 * Extract pnpm version from packageManager field.
 * e.g. "pnpm@10.28.2+sha512.abc..." → "10.28.2"
 */
function extractPnpmVersion(packageManager: string): string | null {
  const match = /^pnpm@([\d.]+)/.exec(packageManager);
  /* v8 ignore next -- defensive: regex ([\d.]+) capture is guaranteed when match succeeds */
  return match?.[1] ?? null;
}

/**
 * Extract major version from a version string.
 * e.g. "10.28.2" → 10
 */
function extractMajor(version: string): number {
  /* v8 ignore next -- defensive: split always returns at least one element */
  const major = version.split('.')[0] ?? '0';
  const parsed = Number.parseInt(major, 10);
  /* v8 ignore next -- defensive: parseInt on digit-only string is always finite */
  return Number.isFinite(parsed) ? parsed : 0;
}

// =============================================================================
// LINE-LEVEL ANALYSIS HELPERS
// =============================================================================

/**
 * Per-Dockerfile analysis context: the file's path (absolute + repo-relative
 * for messages) and the shared violation sink. Threaded so the line-level
 * helpers stay under the wide-function parameter budget.
 */
interface DockerfileVersionContext {
  filePath: string;
  relPath: string;
  violations: CheckViolation[];
}

function checkNodeVersion(
  line: string,
  lineNum: number,
  expectedNodeMajor: number,
  ctx: DockerfileVersionContext,
): void {
  const { filePath, violations } = ctx;
  const nodeMatch = FROM_NODE_PATTERN.exec(line);
  const nodeVersion = nodeMatch?.[1];
  if (!nodeVersion) return;

  // @fitness-ignore-next-line numeric-validation -- regex (\d+) guarantees digit-only string
  const dockerNodeMajor = Number.parseInt(nodeVersion, 10);
  if (dockerNodeMajor !== expectedNodeMajor) {
    violations.push({
      line: lineNum,
      filePath,
      message: `Node major version mismatch: Dockerfile uses node:${dockerNodeMajor} but package.json engines.node requires ${expectedNodeMajor}`,
      severity: 'error',
      suggestion: `Change FROM node:${dockerNodeMajor} to FROM node:${expectedNodeMajor}`,
      type: 'node-version-mismatch',
    });
  }
}

function checkPnpmVersion(
  line: string,
  lineNum: number,
  expectedPnpmVersion: string,
  ctx: DockerfileVersionContext,
): boolean {
  const { filePath, relPath, violations } = ctx;
  const hardcodedMatch = PNPM_HARDCODED_PATTERN.exec(line);
  const hardcodedVersion = hardcodedMatch?.[1];
  if (!hardcodedVersion) return false;

  if (PNPM_DYNAMIC_PATTERN.test(line)) {
    // Dynamic pattern is used — this is the preferred approach, no violation
    return true;
  }

  const hardcodedMajor = extractMajor(hardcodedVersion);
  const expectedMajor = extractMajor(expectedPnpmVersion);
  const isVersionMismatch =
    hardcodedMajor !== expectedMajor || hardcodedVersion !== expectedPnpmVersion;

  if (isVersionMismatch) {
    violations.push({
      line: lineNum,
      filePath,
      message: `pnpm version mismatch: Dockerfile uses pnpm@${hardcodedVersion} but package.json declares pnpm@${expectedPnpmVersion}`,
      severity: 'error',
      suggestion: `Use dynamic version extraction: corepack prepare $(node -e "process.stdout.write(require('./package.json').packageManager.split('+')[0])") --activate`,
      type: 'pnpm-version-mismatch',
    });
  } else {
    // Version matches but is hardcoded — warn to use dynamic pattern
    violations.push({
      line: lineNum,
      filePath,
      message: `Hardcoded pnpm version pnpm@${hardcodedVersion} in ${relPath} — prefer dynamic extraction from package.json`,
      severity: 'warning',
      suggestion: `Use dynamic version extraction: corepack prepare $(node -e "process.stdout.write(require('./package.json').packageManager.split('+')[0])") --activate`,
      type: 'pnpm-hardcoded-version',
    });
  }
  return false;
}

function analyzeDockerfileLines(
  lines: string[],
  expectedNodeMajor: number | null,
  expectedPnpmVersion: string | null,
  ctx: DockerfileVersionContext,
): void {
  for (const [i, rawLine] of lines.entries()) {
    if (!rawLine) continue;
    const line = rawLine.trim();
    const lineNum = i + 1;

    if (expectedNodeMajor !== null) {
      checkNodeVersion(line, lineNum, expectedNodeMajor, ctx);
    }

    if (expectedPnpmVersion !== null) {
      const shouldSkipLine = checkPnpmVersion(line, lineNum, expectedPnpmVersion, ctx);
      if (shouldSkipLine) continue;
    }
  }
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: architecture/docker-version-sync
 *
 * Validates that Dockerfiles keep Node and pnpm versions in sync with package.json:
 * 1. FROM node:XX major version matches engines.node
 * 2. pnpm version is either dynamically derived (preferred) or hardcoded consistently
 */
export const dockerVersionSync = defineCheck({
  id: '15680f1a-134d-4247-b4c2-ca6c6ed9c43d',
  slug: 'docker-version-sync',
  disabled: true,
  scope: { languages: ['json', 'typescript', 'yaml'], concerns: ['config'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Validate Docker Node/pnpm versions match package.json',
  longDescription: `**Purpose:** Ensures Dockerfiles keep Node.js and pnpm versions synchronized with the root \`package.json\` to prevent version drift.

**Detects:**
- \`FROM node:XX\` major version mismatches against \`engines.node\` in root \`package.json\`
- Hardcoded \`corepack prepare pnpm@X.Y.Z\` that differs from \`packageManager\` field
- Hardcoded pnpm versions even when matching (prefers dynamic extraction via \`require('./package.json').packageManager\`)

**Why it matters:** Version mismatches between Dockerfiles and package.json cause inconsistent runtime behavior and hard-to-diagnose production bugs.

**Scope:** Codebase-specific convention. Cross-file analysis via \`analyzeAll\`.`,
  tags: ['docker', 'version-sync', 'architecture'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = [];

    // Read root package.json for version truth
    const rootPkg = readRootPackageJson(process.cwd());
    const expectedNodeMajor = rootPkg.engines?.node ? extractNodeMajor(rootPkg.engines.node) : null;
    const expectedPnpmVersion = rootPkg.packageManager
      ? extractPnpmVersion(rootPkg.packageManager)
      : null;

    for (const filePath of files.paths) {
      // @fitness-ignore-next-line performance-anti-patterns -- sequential file reading to control memory; FileAccessor is lazy
      const content = await files.read(filePath);
      const lines = content.split('\n');
      const relPath = path.relative(process.cwd(), filePath);

      // Skip non-Node Dockerfiles (e.g. Hasura)
      const hasNodeFrom = lines.some((line) => FROM_NODE_PATTERN.test(line.trim()));
      if (!hasNodeFrom) continue;

      void analyzeDockerfileLines(lines, expectedNodeMajor, expectedPnpmVersion, {
        filePath,
        relPath,
        violations,
      });
    }

    return violations;
  },
});
