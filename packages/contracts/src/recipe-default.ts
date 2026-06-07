/**
 * recipe-default — resolve which recipe NAME a tool should use (ADR-0022).
 *
 * Recipes are tool-scoped: `fit`, `graph`, and `sim` each own a separate recipe
 * registry with a disjoint namespace, so a default recipe is a per-tool setting.
 * Each tool reads its own `<tool>.recipe` config block; `cli.recipe` survives
 * only as a DEPRECATED cross-tool fallback (it predates per-tool keys).
 *
 * This helper is pure — the caller supplies the three already-read inputs and
 * gets back the chosen name plus a `tolerant` flag. Tolerance is the ADR-0022
 * guardrail split: a name that came from CONFIG (either `<tool>.recipe` or the
 * deprecated `cli.recipe`) but is absent from the active tool's registry should
 * fall back to the tool's built-in `default` rather than abort the run — the
 * default may legitimately belong to a different tool. An EXPLICIT `--recipe`
 * flag stays strict (`tolerant: false`) so a typo still hard-fails.
 *
 * Lives in contracts (not core, not a single tool) because all three tools
 * consume it and it is part of the CLI↔tool config seam — the same reasoning
 * that puts `loadCliDefaults` here. Resolution precedence:
 *
 *   explicit `--recipe` > `<tool>.recipe` > `cli.recipe` (deprecated) > `default`
 */

/** Where the resolved recipe name came from, in precedence order. */
export type RecipeSource = 'flag' | 'tool-config' | 'cli-config' | 'builtin';

/** Built-in recipe name every tool registers (all rules / all checks). */
export const BUILTIN_DEFAULT_RECIPE = 'default';

export interface ResolvedRecipe {
  /** The recipe name the tool should look up in its registry. */
  readonly name: string;
  /** Which input supplied {@link name}. */
  readonly source: RecipeSource;
  /**
   * `false` only when `source === 'flag'`. When `true`, an unknown `name`
   * should fall back to {@link BUILTIN_DEFAULT_RECIPE} with a warning instead
   * of aborting — the name came from config and may target another tool.
   */
  readonly tolerant: boolean;
  /**
   * `true` when the deprecated `cli.recipe` fallback supplied the name — the
   * caller should emit a one-line deprecation warning pointing at the per-tool
   * `<tool>.recipe` key.
   */
  readonly usedDeprecatedCliRecipe: boolean;
}

/** A config value counts as "set" only when it is a non-empty string. */
function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/**
 * Resolve the recipe name for a tool from its three possible sources. See the
 * module docstring for precedence and the tolerance contract (ADR-0022).
 *
 * @param input.explicit   The `--recipe <name>` flag value (strict if present).
 * @param input.toolRecipe The tool's own `<tool>.recipe` config default.
 * @param input.cliRecipe  The deprecated cross-tool `cli.recipe` fallback.
 */
export function resolveToolRecipeName(input: {
  readonly explicit?: string;
  readonly toolRecipe?: string;
  readonly cliRecipe?: string;
}): ResolvedRecipe {
  if (isSet(input.explicit)) {
    return { name: input.explicit, source: 'flag', tolerant: false, usedDeprecatedCliRecipe: false };
  }
  if (isSet(input.toolRecipe)) {
    return { name: input.toolRecipe, source: 'tool-config', tolerant: true, usedDeprecatedCliRecipe: false };
  }
  if (isSet(input.cliRecipe)) {
    return { name: input.cliRecipe, source: 'cli-config', tolerant: true, usedDeprecatedCliRecipe: true };
  }
  return { name: BUILTIN_DEFAULT_RECIPE, source: 'builtin', tolerant: true, usedDeprecatedCliRecipe: false };
}
