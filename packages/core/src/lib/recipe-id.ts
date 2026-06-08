/**
 * deriveRecipeId — the one recipe-id derivation every domain shares (north-star
 * §5.8, release 2.13.0).
 *
 * Before 2.13.0 the three domains derived ids divergently — fitness `RCP_${name}`,
 * graph `GRCP_${name}`, sim hardcoded `BSCP_default`. The format is identical
 * (`<prefix>_<name>`); this hoists it so the derivation is one function, not three
 * inline templates. The prefix stays per-domain (so existing ids are unchanged),
 * but the scheme is shared.
 */

/** Derive a recipe id as `<prefix>_<name>` (e.g. `deriveRecipeId('RCP', 'example')`). */
export function deriveRecipeId(prefix: string, name: string): string {
  return `${prefix}_${name}`;
}
