// @fitness-ignore-file fitness-check-standards -- Uses fs for package.json reading, not source file content
// @fitness-ignore-file detached-promises -- helpers (checkNvmrc, checkWorkspaceEngines, checkTypesNode, checkCiWorkflow) are synchronous violation-collectors; heuristic flags them despite returning void
/**
 * @fileoverview Node version consistency fitness check
 * @invariants
 * - All engines.node fields must match root package.json
 * - .nvmrc major version must match engines.node
 * - @types/node major version must match engines.node
 * - CI workflow node-version must match engines.node
 * - Dockerfiles are NOT checked (covered by docker-version-sync)
 */

import * as path from 'node:path';

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-cli/fitness';

// =============================================================================
// TYPES
// =============================================================================

interface RootPackageJson {
  engines?: {
    node?: string;
  };
  devDependencies?: Record<string, string>;
}

interface WorkspacePackageJson {
  name?: string;
  engines?: {
    node?: string;
  };
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

// =============================================================================
// REGEX PATTERNS
// =============================================================================

/** Extract major version from engines.node constraint like ">=24.0.0" -> 24 */
const ENGINES_NODE_MAJOR = /(\d+)/;

/** Match @types/node version like "^24.0.0" -> 24 */
const TYPES_NODE_MAJOR = /\^(\d+)/;

/** Match node-version in CI workflow YAML */
const CI_NODE_VERSION = /node-version:\s*['"]?(\d+)['"]?/;

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Extract major Node version from engines.node constraint.
 * e.g. ">=24.0.0" -> 24
 */
function extractNodeMajor(constraint: string): number | null {
  const match = ENGINES_NODE_MAJOR.exec(constraint);
  /* v8 ignore next 3 -- defensive: regex (\d+) ensures group [1] is set when match succeeds */
  const digit = match?.[1];
  // @fitness-ignore-next-line numeric-validation -- regex guarantees digit-only string; null guard above
  return digit ? Number.parseInt(digit, 10) : null;
}

// =============================================================================
// PER-FILE ANALYSIS HELPERS
// =============================================================================

function checkNvmrc(
  content: string,
  filePath: string,
  expectedMajor: number,
  violations: CheckViolation[],
): void {
  const trimmed = content.trim();
  const nvmrcMajor = Number.parseInt(trimmed, 10);
  /* v8 ignore next -- defensive: malformed .nvmrc not exercised in fixtures */
  if (Number.isNaN(nvmrcMajor)) return;

  if (nvmrcMajor !== expectedMajor) {
    violations.push({
      line: 1,
      filePath,
      message: `.nvmrc specifies Node ${nvmrcMajor} but root package.json engines.node requires ${expectedMajor}`,
      severity: 'error',
      suggestion: `Change .nvmrc from "${trimmed}" to "${expectedMajor}"`,
      type: 'nvmrc-version-mismatch',
    });
  }
}

function checkWorkspaceEngines(
  content: string,
  filePath: string,
  expectedMajor: number,
  rootConstraint: string,
  violations: CheckViolation[],
): void {
  let pkg: WorkspacePackageJson;
  try {
    pkg = JSON.parse(content) as WorkspacePackageJson;
  } catch {
    /* v8 ignore next -- defensive: malformed workspace package.json not exercised in fixtures */
    // @swallow-ok expected for non-JSON files or malformed package.json
    return;
  }

  const enginesNode = pkg.engines?.node;
  if (!enginesNode) return;

  const workspaceMajor = extractNodeMajor(enginesNode);
  /* v8 ignore next -- defensive: enginesNode already checked, regex match guaranteed */
  if (workspaceMajor === null) return;

  if (workspaceMajor !== expectedMajor) {
    const relPath = path.relative(process.cwd(), filePath);
    violations.push({
      line: 1,
      filePath,
      message: `${relPath} engines.node is "${enginesNode}" but root package.json has "${rootConstraint}"`,
      severity: 'error',
      suggestion: `Change engines.node from "${enginesNode}" to "${rootConstraint}"`,
      type: 'workspace-engines-mismatch',
    });
  }
}

function checkTypesNode(
  content: string,
  filePath: string,
  expectedMajor: number,
  violations: CheckViolation[],
): void {
  let pkg: WorkspacePackageJson;
  try {
    pkg = JSON.parse(content) as WorkspacePackageJson;
  } catch {
    /* v8 ignore next -- defensive: malformed workspace package.json not exercised in fixtures */
    // @swallow-ok expected for non-JSON files or malformed package.json
    return;
  }

  /* v8 ignore next -- defensive: pkg.dependencies fallback when devDependencies missing */
  const typesNodeVersion =
    pkg.devDependencies?.['@types/node'] ?? pkg.dependencies?.['@types/node'];
  if (!typesNodeVersion) return;

  const match = TYPES_NODE_MAJOR.exec(typesNodeVersion);
  /* v8 ignore next 2 -- defensive: regex ^\d+ ensures group [1] is set when match succeeds */
  const typesMajor = match?.[1];
  if (!typesMajor) return;

  // @fitness-ignore-next-line numeric-validation -- regex ^\d+ guarantees digit-only string
  const typesMajorNum = Number.parseInt(typesMajor, 10);
  if (typesMajorNum !== expectedMajor) {
    const relPath = path.relative(process.cwd(), filePath);
    violations.push({
      line: 1,
      filePath,
      message: `${relPath} has @types/node "${typesNodeVersion}" but engines.node major is ${expectedMajor}`,
      severity: 'error',
      suggestion: `Change @types/node from "${typesNodeVersion}" to "^${expectedMajor}.0.0"`,
      type: 'types-node-mismatch',
    });
  }
}

function checkCiWorkflow(
  content: string,
  filePath: string,
  expectedMajor: number,
  violations: CheckViolation[],
): void {
  const lines = content.split('\n');
  for (const [i, rawLine] of lines.entries()) {
    /* v8 ignore next -- defensive: lines.entries() never yields undefined */
    if (!rawLine) continue;
    const line = rawLine.trim();

    const match = CI_NODE_VERSION.exec(line);
    /* v8 ignore next 2 -- defensive: regex (\d+) ensures group [1] is set when match succeeds */
    const ciVersion = match?.[1];
    if (!ciVersion) continue;

    // @fitness-ignore-next-line numeric-validation -- regex (\d+) guarantees digit-only string
    const ciMajor = Number.parseInt(ciVersion, 10);
    if (ciMajor !== expectedMajor) {
      violations.push({
        line: i + 1,
        filePath,
        message: `CI workflow uses node-version: '${ciVersion}' but root package.json engines.node requires ${expectedMajor}`,
        severity: 'error',
        suggestion: `Change node-version from '${ciVersion}' to '${expectedMajor}'`,
        type: 'ci-node-version-mismatch',
      });
    }
  }
}

// =============================================================================
// CHECK DEFINITION
// =============================================================================

/**
 * Check: architecture/node-version-consistency
 *
 * Validates that Node.js version references are consistent across the codebase:
 * 1. .nvmrc matches root package.json engines.node
 * 2. All workspace package.json engines.node fields match root
 * 3. @types/node major version matches engines.node major
 * 4. CI workflow node-version matches engines.node
 *
 * Note: Dockerfile FROM node:XX checks are handled by docker-version-sync.
 */
export const nodeVersionConsistency = defineCheck({
  id: 'e32068df-b100-4406-a8ba-caec5d53fa92',
  slug: 'node-version-consistency',
  scope: { languages: ['json', 'typescript', 'yaml'], concerns: ['config'] },
  contentFilter: 'raw',

  confidence: 'medium',
  description: 'Validate Node.js version consistency across configs',
  longDescription: `**Purpose:** Ensures all Node.js version references across the codebase stay in sync with the root \`package.json\` \`engines.node\` field.

**Detects:**
- \`.nvmrc\` major version mismatches against \`engines.node\`
- Workspace \`package.json\` \`engines.node\` fields that differ from root
- \`@types/node\` major version mismatches in any \`package.json\`
- CI workflow \`node-version:\` lines that don't match

**Why it matters:** Version drift between .nvmrc, CI, and package.json leads to "works on my machine" issues and inconsistent runtime behavior.

**Scope:** Codebase-specific convention. Cross-file analysis via \`analyzeAll\`. Dockerfiles are intentionally excluded (covered by \`docker-version-sync\`).`,
  tags: ['node', 'version-sync', 'architecture'],

  async analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
    const violations: CheckViolation[] = [];

    // Find the root package.json from the scanned file set.
    // The root is the shortest path (shallowest) package.json in the set.
    const packageJsonPaths = files.paths.filter((p) => path.basename(p) === 'package.json');
    if (packageJsonPaths.length === 0) return violations;

    const rootPkgPath = packageJsonPaths.reduce(
      (shortest, p) => (p.length < shortest.length ? p : shortest),
      /* v8 ignore next -- defensive: packageJsonPaths.length checked above */
      packageJsonPaths[0],
    );
    // Read root package.json for version truth
    const rootContent = await files.read(rootPkgPath);
    let rootPkg: RootPackageJson;
    try {
      rootPkg = JSON.parse(rootContent) as RootPackageJson;
    } catch {
      return violations;
    }
    const rootConstraint = rootPkg.engines?.node;
    if (!rootConstraint) return violations;

    const expectedMajor = extractNodeMajor(rootConstraint);
    /* v8 ignore next -- defensive: rootConstraint already checked, regex (\d+) ensures match */
    if (expectedMajor === null) return violations;

    for (const filePath of files.paths) {
      const content = await files.read(filePath);
      const basename = path.basename(filePath);

      if (basename === '.nvmrc') {
        checkNvmrc(content, filePath, expectedMajor, violations);
      } else if (basename === 'package.json') {
        // Skip root package.json (it's the source of truth)
        if (filePath === rootPkgPath) continue;

        checkWorkspaceEngines(content, filePath, expectedMajor, rootConstraint, violations);
        checkTypesNode(content, filePath, expectedMajor, violations);
      } else if (filePath.includes('.github/workflows/') && basename.endsWith('.yml')) {
        checkCiWorkflow(content, filePath, expectedMajor, violations);
      }
    }

    return violations;
  },
});
