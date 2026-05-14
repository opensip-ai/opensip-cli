/**
 * @fileoverview Path matching utilities for fitness checks
 * @version 1.0.0
 *
 * Factory functions for creating path matchers that can work with
 * both string patterns (using includes) and RegExp patterns (using test).
 */

/**
 * A path pattern can be a string (for includes matching) or a RegExp (for test matching).
 */
export type PathPattern = string | RegExp

/**
 * Creates a path matcher function from an array of patterns.
 *
 * String patterns match using `path.includes(pattern)`.
 * RegExp patterns match using `pattern.test(path)`.
 *
 * @param patterns - Array of string or RegExp patterns to match against
 * @returns A function that returns true if the path matches any pattern
 *
 * @example
 * ```typescript
 * // String patterns (includes matching)
 * const isExcluded = createPathMatcher(['/__tests__/', '/node_modules/']);
 * isExcluded('/src/__tests__/foo.ts'); // true
 *
 * // RegExp patterns (test matching)
 * const isTestFile = createPathMatcher([/\.test\.ts$/, /\.spec\.ts$/]);
 * isTestFile('foo.test.ts'); // true
 *
 * // Mixed patterns
 * const isIgnored = createPathMatcher(['/dist/', /node_modules/]);
 * isIgnored('/project/dist/bundle.js'); // true
 * isIgnored('/project/node_modules/lodash/index.js'); // true
 * ```
 */
export function createPathMatcher(patterns: readonly PathPattern[]): (path: string) => boolean {
  return (path) => patterns.some((p) => (typeof p === 'string' ? path.includes(p) : p.test(path)))
}
