/** Minimal check shape needed by display-parity assertions. */
export interface DisplayParityCheck {
  readonly config: {
    readonly slug: string;
  };
}

/** Return display-table keys that do not correspond to a registered check slug. */
export function findOrphanedDisplayKeys(
  checks: readonly DisplayParityCheck[],
  display: Readonly<Record<string, unknown>>,
): string[] {
  const slugs = new Set(checks.map((check) => check.config.slug));
  return Object.keys(display)
    .filter((key) => !slugs.has(key))
    .sort();
}
