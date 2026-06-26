/**
 * Display-only recipe listing helpers — shared metadata projection without
 * selector resolution or execution.
 */

/** Minimum recipe metadata required for list projection. */
export interface RecipeDisplaySource {
  readonly name: string;
  readonly description: string;
  readonly tags?: readonly string[];
}

/** Neutral recipe row metadata for list commands. */
export interface RecipeDisplayInfo {
  readonly name: string;
  readonly description: string;
  readonly tags?: readonly string[];
  readonly selectionLabel: string;
}

/** Copy generic recipe metadata and attach a tool-owned selection label. */
export function recipeDisplayInfo(
  recipe: RecipeDisplaySource,
  selectionLabel: string,
): RecipeDisplayInfo {
  return {
    name: recipe.name,
    description: recipe.description,
    ...(recipe.tags === undefined ? {} : { tags: recipe.tags }),
    selectionLabel,
  };
}

/** Label for selectors that include every unit (`all checks`, `all rules`, …). */
export function allUnitsLabel(plural: string): string {
  return `all ${plural}`;
}

/** Label for explicit unit lists with singular/plural grammar. */
export function explicitUnitsLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Label for pattern- or tag-based selectors. */
export const PATTERN_BASED_LABEL = 'pattern-based';

/** Label for built-in vs user-defined recipe origin (simulation). */
export function builtInOriginLabel(isBuiltIn: boolean): string {
  return isBuiltIn ? 'built-in' : 'user-defined';
}
