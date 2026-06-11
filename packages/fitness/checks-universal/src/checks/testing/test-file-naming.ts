/**
 * @fileoverview Validates test file naming conventions
 *
 * Test files should follow the pattern *.test.ts or *.spec.ts
 * and be located in __tests__ directories.
 */
// @fitness-ignore-file fitness-check-standards -- Uses fs for directory listing/stat operations, not file content reading

import * as fs from 'node:fs';
import * as path from 'node:path';

import { logger } from '@opensip-tools/core';
import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness';

/**
 * Valid test file patterns
 */
const VALID_TEST_PATTERNS = [
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\.bench\.[jt]sx?$/, // Benchmark files
  /\.contract\.[jt]sx?$/, // Contract test files
];

/**
 * Files/patterns to ignore (test utilities, helpers, setup files)
 */
const IGNORED_PATTERNS = [
  /^_/, // Underscore-prefixed files are private helpers/runners by convention
  /^setup\.[jt]sx?$/, // Test setup files
  /^test-setup\.[jt]sx?$/, // Test setup files
  /-test-setup\.[jt]sx?$/, // Test setup files with module prefix (e.g. git-worktree-test-setup.ts)
  /^test-context\.[jt]sx?$/, // Test context files
  /\.setup\.[jt]sx?$/, // Setup files with prefix
  /^mock[-_]/, // Mock files
  /^_mocks?\.[jt]sx?$/, // Underscore-prefix mock files (e.g. _mocks.ts)
  /-mock\.[jt]sx?$/, // Mock files with suffix
  /-mocks\.[jt]sx?$/, // Mock files with plural suffix
  /[-_]helpers?\.[jt]sx?$/, // Helper files
  /\.test\.helpers?\.[jt]sx?$/, // Test-only helper files (e.g. service.test.helpers.ts)
  /[-_.]fixtures?\.[jt]sx?$/, // Fixture files (foo-fixtures.ts, catalog.fixture.ts, …)
  /[-_.]allowlist\.[jt]sx?$/, // Allowlist data modules (test config/data, not test cases)
  /[-_]utils?\.[jt]sx?$/, // Utility files
  /^services\.[jt]sx?$/, // Service mocks
  /^index\.[jt]sx?$/, // Index files (re-exports)
];

/**
 * Directories to skip (build artifacts, etc.)
 *
 * `fixtures` / `__fixtures__` and `test-utils` are subdirectories used to
 * host test inputs and per-package scope helpers — their files don't follow
 * `.test.ts` naming because they're not test files in the Vitest-discovery
 * sense.
 */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.turbo',
  'fixtures',
  '__fixtures__',
  'test-utils',
]);

/**
 * Directories to scan for tests
 */
const SCAN_DIRECTORIES = ['packages', 'services', 'apps', 'tools'];

function isPotentialTestFile(entry: string): boolean {
  logger.debug({
    evt: 'fitness.checks.test_file_naming.is_potential_test_file',
    msg: 'Checking if entry is a potential test file',
  });
  const isTypeScriptFile = entry.endsWith('.ts') || entry.endsWith('.tsx');
  const isJavaScriptFile = entry.endsWith('.js') || entry.endsWith('.jsx');
  const isDeclarationFile = entry.endsWith('.d.ts');
  return (isTypeScriptFile || isJavaScriptFile) && !isDeclarationFile;
}

/**
 * Recursively check __tests__ directory for naming violations
 */
function checkTestsDirectory(testsDir: string, cwd: string): CheckViolation[] {
  logger.debug({
    evt: 'fitness.checks.test_file_naming.check_tests_directory',
    msg: 'Checking __tests__ directory for naming violations',
  });
  const violations: CheckViolation[] = [];

  try {
    const entries = fs.readdirSync(testsDir);

    for (const entry of entries) {
      const fullPath = path.join(testsDir, entry);
      const stat = fs.statSync(fullPath);

      if (stat.isFile() && isPotentialTestFile(entry)) {
        // Skip files matching ignored patterns (helpers, setup, mocks, etc.)
        const isIgnoredFile = IGNORED_PATTERNS.some((pattern) => pattern.test(entry));
        if (isIgnoredFile) continue;

        // Check if file follows valid test pattern
        const isValidTestFile = VALID_TEST_PATTERNS.some((pattern) => pattern.test(entry));

        if (!isValidTestFile) {
          const baseName = entry.replace(/\.[jt]sx?$/, '');
          violations.push({
            line: 1,
            message: `Test file "${entry}" should end with .test.ts or .spec.ts`,
            severity: 'warning',
            type: 'wrong-naming',
            suggestion: `Rename the file: mv ${entry} ${baseName}.test.ts (or ${baseName}.spec.ts)`,
            match: entry,
            filePath: fullPath,
          });
        }
      } else if (stat.isDirectory()) {
        // Skip build artifact directories
        if (SKIP_DIRECTORIES.has(entry)) continue;

        // Recurse into subdirectories (like unit/, integration/, fixtures/, helpers/)
        const subViolations = checkTestsDirectory(fullPath, cwd);
        violations.push(...subViolations);
      }
    }
  } catch {
    // @swallow-ok Ignore read errors
  }

  return violations;
}

/**
 * Recursively scan directory for __tests__ folders
 */
function scanDirectory(dirPath: string, cwd: string): CheckViolation[] {
  logger.debug({
    evt: 'fitness.checks.test_file_naming.scan_directory',
    msg: 'Scanning directory for __tests__ folders',
  });
  const violations: CheckViolation[] = [];

  try {
    const entries = fs.readdirSync(dirPath);

    for (const entry of entries) {
      // Skip ignored directories (node_modules, dist, build, etc.)
      if (SKIP_DIRECTORIES.has(entry) || entry.startsWith('.')) continue;

      const fullPath = path.join(dirPath, entry);
      const stat = fs.statSync(fullPath);

      if (!stat.isDirectory()) continue;

      if (entry === '__tests__') {
        // Found a __tests__ directory, check all files
        const testViolations = checkTestsDirectory(fullPath, cwd);
        violations.push(...testViolations);
      } else {
        // Recurse into subdirectory
        const subViolations = scanDirectory(fullPath, cwd);
        violations.push(...subViolations);
      }
    }
  } catch {
    // @swallow-ok Ignore read errors
  }

  return violations;
}

/**
 * Analyze all files for test naming violations
 */
// @fitness-ignore-next-line concurrency-safety -- async keyword required by analyzeAll interface contract; synchronous analysis implementation
// eslint-disable-next-line @typescript-eslint/require-await -- AnalyzeAllCheckConfig requires Promise<CheckViolation[]>; this implementation is synchronous
async function analyzeAll(files: FileAccessor): Promise<CheckViolation[]> {
  logger.debug({
    evt: 'fitness.checks.test_file_naming.analyze_all',
    msg: 'Analyzing all files for test naming violations',
  });
  // Get the cwd from the first file path (all paths are absolute)
  const firstPath = files.paths[0];
  if (!firstPath) {
    return [];
  }

  // Find the repo root by looking for packages directory
  let cwd = path.dirname(firstPath);
  while (cwd !== '/' && !fs.existsSync(path.join(cwd, 'packages'))) {
    cwd = path.dirname(cwd);
  }

  const violations: CheckViolation[] = [];

  // Scan __tests__ directories
  for (const dir of SCAN_DIRECTORIES) {
    const dirPath = path.join(cwd, dir);
    if (fs.existsSync(dirPath)) {
      const dirViolations = scanDirectory(dirPath, cwd);
      violations.push(...dirViolations);
    }
  }

  return violations;
}

/**
 * Check: testing/test-file-naming
 *
 * Validates test file naming conventions follow *.test.ts or *.spec.ts patterns.
 */
export const testFileNaming = defineCheck({
  id: '7c26c9ae-2944-46e1-a49b-817b81aba0e6',
  slug: 'test-file-naming',
  scope: { languages: ['typescript', 'tsx'], concerns: ['testing'] },
  contentFilter: 'strip-strings',

  confidence: 'medium',
  description: 'Validates test file naming conventions follow *.test.ts or *.spec.ts patterns',
  longDescription: `**Purpose:** Ensures all files inside \`__tests__/\` directories follow recognized test file naming conventions so test runners can discover them.

**Detects:**
- Files in \`__tests__/\` directories that don't match \`.test.[jt]sx?\`, \`.spec.[jt]sx?\`, \`.bench.[jt]sx?\`, or \`.contract.[jt]sx?\` patterns (\`wrong-naming\`)
- Ignores known non-test files: setup files (\`setup.ts\`, \`test-setup.ts\`), mock files (\`mock-*\`, \`*-mock.ts\`), helpers, fixtures, utils, service mocks, and index re-exports
- Recursively scans \`__tests__/\` directories under \`packages/\`, \`services/\`, \`apps/\`, and \`tools/\`
- Skips \`node_modules\`, \`dist\`, \`build\`, \`coverage\`, \`.turbo\`, and \`.d.ts\` files

**Why it matters:** Incorrectly named test files are invisible to test runners, silently excluding them from the test suite and reducing effective coverage.

**Scope:** General best practice. Cross-file analysis via \`analyzeAll\` scanning \`__tests__/\` directories across the workspace.`,
  tags: ['testing', 'consistency'],
  fileTypes: ['ts', 'tsx'],

  analyzeAll,
});
