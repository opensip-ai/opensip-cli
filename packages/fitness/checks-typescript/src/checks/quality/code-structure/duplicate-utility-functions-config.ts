/**
 * Recipe-config shape for the duplicate-utility-functions check. Augments
 * the built-in {@link DOMAIN_SPECIFIC_FUNCTIONS} list with project-specific
 * names that are deliberately distinct implementations sharing a name.
 */
export interface DuplicateUtilityFunctionsConfig extends Record<string, unknown> {
  /** Function names that should be skipped (treated as domain-specific by design). */
  additionalDomainSpecificFunctions?: readonly string[];
}

/**
 * Functions that are intentionally domain-specific and should NOT be flagged
 * as duplicates. Limited to genuinely generic identifiers — config / factory
 * / logger / common type-guard names — that almost any TS codebase will hit.
 */
export const DOMAIN_SPECIFIC_FUNCTION_NAMES: readonly string[] = [
  'getConfig',
  'getDefaultConfig',
  'getContainer',
  'getFactory',
  'getLogger',
  'isPlainObject',
  'isStringArray',
  'isCommentLine',
  'isTestFile',
  'isValidEmail',
  'formatDate',
  'formatTimestamp',
  'parseArgs',
  'validateConfig',
  'validateSchema',
  'getErrorMessage',
  'isPropertyAccess',
  'isFunctionLike',
  'getSharedSourceFile',
  'getLineNumber',
  'isReturnValueDiscarded',
  'hasPackageJson',
  'normalizeProjectDir',
  'parseProject',
  'isIdentChar',
  'validateAssertions',
];