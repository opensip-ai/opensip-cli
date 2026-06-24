/**
 * @fileoverview Null-safety recipe config and safe-by-construction allowlists.
 */

import { getCheckConfig } from '@opensip-cli/fitness';

import { SAFE_BUILDER_PREFIXES } from './null-safety-prefixes.js';

export {
  SAFE_BUILDER_PREFIXES,
  SAFE_FLUENT_METHOD_NAMES,
  isSafeFluentMethod,
} from './null-safety-prefixes.js';

/**
 * Recipe-config shape for null-safety. Project-specific safe-by-construction
 * paths and factory/builder symbols belong in a recipe's
 * `checks.config['null-safety']` block, not in the check's built-in defaults.
 */
export interface NullSafetyConfig extends Record<string, unknown> {
  /**
   * Additional path patterns whose files are skipped entirely. Each entry
   * is compiled to a case-insensitive RegExp via `new RegExp(entry, 'i')`.
   */
  additionalSafeNullPaths?: readonly string[];
  /**
   * Additional call-text prefixes treated as non-null by construction (a
   * property access on a matching call result is not flagged). Use this for
   * PROJECT-SPECIFIC factory/builder functions whose non-null contract is
   * local to your codebase — do not hardcode them into the shipped check.
   * Matched via `String.prototype.startsWith` against the full call text.
   */
  additionalSafeBuilders?: readonly string[];
  /**
   * Use TYPE-AWARE analysis (a real `ts.Program` + `TypeChecker`): a property
   * access on a call/element-access result is flagged only when the receiver's
   * ACTUAL static type includes `null`/`undefined` (`any`/`unknown`/unresolved →
   * not flagged; the checker also handles control-flow narrowing, builder/Zod
   * return types, and chain depth, so the verb-prefix convention does not apply).
   * `additionalSafeBuilders` remains a manual escape hatch for symbols the checker
   * cannot resolve.
   *
   * **Default `true`** (D2). Set `false` to fall back to the legacy
   * name/convention heuristic (faster, no Program build, but higher
   * false-negative rate — it trusts any `get*`/`find*`/… call as non-null).
   */
  typeAware?: boolean;
}

/** Patterns that indicate the access is already protected */
export const SAFE_PATTERNS = [/\?\./, /!!/, /\?\?/, /if\s*\(/, /&&/];

/**
 * Common method name prefixes that indicate safe (non-null) return values.
 */
export const SAFE_METHOD_PREFIXES = [
  'get',
  'set',
  'is',
  'has',
  'to',
  'with',
  'from',
  'of',
  'create',
  'build',
  'add',
  'remove',
  'update',
  'delete',
  'find',
  'load',
  'save',
  'parse',
  'format',
  'validate',
  'check',
  'resolve',
  'register',
  'unregister',
  'read',
  'open',
  'compute',
  'make',
  'render',
  'ensure',
  'classify',
  'filter',
  'current',
  'pick',
  'select',
];

const SAFE_NULL_PATHS: readonly RegExp[] = [
  /\/di\/fragment\.ts$/,
  /\/di\/fragments\//,
  /\/schema\//,
  /-schema\.ts$/,
];

/** Merge built-in defaults with the recipe-config slice. */
export function buildEffectiveSafePaths(): readonly RegExp[] {
  const cfg = getCheckConfig<NullSafetyConfig>('null-safety');
  const extras = (cfg.additionalSafeNullPaths ?? []).map((src) => new RegExp(src, 'i'));
  return [...SAFE_NULL_PATHS, ...extras];
}

/** Merge built-in safe-builder prefixes with recipe-config augmentation. */
export function buildEffectiveSafeBuilders(): readonly string[] {
  const cfg = getCheckConfig<NullSafetyConfig>('null-safety');
  return [...SAFE_BUILDER_PREFIXES, ...(cfg.additionalSafeBuilders ?? [])];
}

export function isSafeNullPath(filePath: string, paths: readonly RegExp[]): boolean {
  return paths.some((p) => p.test(filePath));
}
