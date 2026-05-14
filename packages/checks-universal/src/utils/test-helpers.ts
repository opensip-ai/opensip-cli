// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
/**
 * @fileoverview Unified test file detection utilities
 * @version 1.0.0
 *
 * Consolidated test file detection that replaces various duplicated implementations.
 * These utilities are specific to code analysis tooling.
 */

/**
 * Options for isTestFile detection
 */
export interface IsTestFileOptions {
  /**
   * Check for __tests__ directory pattern
   * @default true
   */
  checkTestsDir?: boolean

  /**
   * Check for .test.ts/.test.tsx extension pattern
   * @default true
   */
  checkTestExtension?: boolean

  /**
   * Check for .spec.ts/.spec.tsx extension pattern
   * @default true
   */
  checkSpecExtension?: boolean

  /**
   * Exclude .d.ts declaration files from being considered test files
   * @default true
   */
  excludeDeclarationFiles?: boolean

  /**
   * Additional custom patterns to check (RegExp patterns)
   * @default []
   */
  additionalPatterns?: RegExp[]
}

/**
 * Standard test file patterns used across the codebase
 */
export const TEST_FILE_PATTERNS = {
  /** Files ending with .test.ts or .test.tsx */
  testExtension: /\.test\.tsx?$/,

  /** Files ending with .spec.ts or .spec.tsx */
  specExtension: /\.spec\.tsx?$/,

  /** Files in __tests__ directory */
  testsDirectory: /__tests__[/\\]/,

  /** Declaration files that should be excluded */
  declarationFile: /\.d\.ts$/,
} as const

/**
 * Check if a file path is a test file.
 *
 * @param filePath - File path to check
 * @param options - Detection options
 * @returns True if the file is a test file
 *
 * @example
 * // Default: comprehensive check
 * isTestFile('src/__tests__/utils.test.ts') // true
 * isTestFile('src/utils.ts') // false
 * isTestFile('src/types.d.ts') // false
 *
 * @example
 * // Check only specific patterns
 * isTestFile('src/foo.spec.ts', { checkTestsDir: false }) // true
 * isTestFile('src/__tests__/foo.ts', { checkTestExtension: false, checkSpecExtension: false }) // true
 */
export function isTestFile(filePath: string, options: IsTestFileOptions = {}): boolean {
  const {
    checkTestsDir = true,
    checkTestExtension = true,
    checkSpecExtension = true,
    excludeDeclarationFiles = true,
    additionalPatterns = [],
  } = options

  // Normalize path separators for cross-platform compatibility
  const normalized = filePath.replace(/\\/g, '/')

  // Exclude declaration files first
  if (excludeDeclarationFiles && normalized.endsWith('.d.ts')) {
    return false
  }

  // Check __tests__ directory
  if (checkTestsDir && TEST_FILE_PATTERNS.testsDirectory.test(normalized)) {
    return true
  }

  // Check .test.ts/.test.tsx extension
  if (checkTestExtension && TEST_FILE_PATTERNS.testExtension.test(normalized)) {
    return true
  }

  // Check .spec.ts/.spec.tsx extension
  if (checkSpecExtension && TEST_FILE_PATTERNS.specExtension.test(normalized)) {
    return true
  }

  // Check additional custom patterns
  for (const pattern of additionalPatterns) {
    if (pattern.test(normalized)) {
      return true
    }
  }

  return false
}

