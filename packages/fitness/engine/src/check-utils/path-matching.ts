/**
 * @fileoverview Path matching utilities for fitness checks.
 *
 * Factory function for creating path matchers that work with both string
 * patterns (using `includes`) and RegExp patterns (using `test`). Previously
 * each check pack carried a byte-identical copy of this helper — surfaced by
 * the graph tool's duplicated-function-body rule. Both packs depend on
 * @opensip-cli/fitness, so the engine is the natural shared home.
 */

/**
 * A path pattern can be a string (for includes matching) or a RegExp (for test matching).
 */
export type PathPattern = string | RegExp;

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
  return (path) => patterns.some((p) => (typeof p === 'string' ? path.includes(p) : p.test(path)));
}
