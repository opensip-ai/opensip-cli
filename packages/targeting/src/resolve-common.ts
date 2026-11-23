/** Infrastructure directories excluded from every target walk. */
export const COMMON_TARGET_IGNORE = Object.freeze([
  '**/node_modules/**',
  '**/dist/**',
  '**/.git/**',
]);

/**
 * Strip a leading `./` (repeated) from a glob pattern before compiling it
 * with `Minimatch` for a post-glob path match. `glob`'s own `Ignore` class
 * does this for its `ignore` option (https://github.com/isaacs/node-glob/issues/570),
 * so a pattern like `./generated/**` matches a relative candidate path
 * (`generated/foo.ts`, no `./` prefix) there. A bare `new Minimatch(pattern, ...)`
 * does not strip it, so the same pattern silently matches nothing when matched
 * directly against a relative path — exactly what every post-glob exclude
 * filter in this package does. Mirrors `stripLeadingDotSegments` in
 * `bounded-resolve-matchers.ts`.
 */
export function stripLeadingDotSegments(pattern: string): string {
  let normalized = pattern;
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}
