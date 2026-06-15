/**
 * @fileoverview Recognized non-code format tags.
 *
 * The `languages:` field on a target (and the matching `scope.languages`
 * on a check) is a *matching dimension* — it routes files to checks via
 * `findByScope`. A SUBSET of those tags also have a registered
 * {@link LanguageAdapter} that can parse the file and strip its
 * strings/comments for content-aware checks.
 *
 * Structured-data and markup formats (JSON, YAML, Markdown, …) are
 * legitimate matching tags but have NO adapter by design: there is no
 * meaningful "strip strings/comments" pass for them (stripping JSON
 * "strings" would blank out object keys that checks like
 * `cluster-coupling` and `table-access-ownership` match on), so the
 * content filter correctly returns them raw.
 *
 * This set names those intentional adapter-less tags so config
 * validation can tell them apart from a genuine typo. A target declaring
 * `languages: ['json']` is fine; `languages: ['pythonn']` is a mistake.
 */

/**
 * Format tags that are valid `languages:` matching tags but intentionally
 * have no content-filter adapter. Files in these formats scan as raw
 * content — there is nothing to strip.
 *
 * Lowercase, canonical. Extend this set when a new adapter-less format
 * tag becomes a legitimate scope dimension (the alternative is to ship a
 * real {@link LanguageAdapter} for it).
 */
export const RECOGNIZED_NON_CODE_FORMATS: ReadonlySet<string> = new Set([
  'json',
  'yaml',
  'markdown',
  'toml',
  'plaintext',
]);

/**
 * True when `tag` is a recognized non-code format — a valid scope tag
 * that has no content-filter adapter by design. Comparison is
 * case-insensitive.
 */
export function isRecognizedNonCodeFormat(tag: string): boolean {
  return RECOGNIZED_NON_CODE_FORMATS.has(tag.toLowerCase());
}
