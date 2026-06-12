/**
 * The completion-invariant index, made executable (3.0.0 GA, north-star §8).
 *
 * GA's bar is "the acceptance test passes AND all nine completion invariants are
 * live guardrails." This test asserts the second half mechanically: every check
 * slug the index (`docs/internal/parity-invariant-index.md`) names as the
 * enforcement for a §8 invariant resolves to a registered fitness check. So
 * deleting or renaming a parity guardrail — without updating the index — fails
 * CI. (The dogfood gate `fit --gate-save` independently asserts each is at 0
 * findings; the acceptance test `fit-external-load.test.ts` is invariant 1's
 * executable form.)
 *
 * The check packs are bundled deps of the CLI (the dogfood loads them), so this
 * host-level test can resolve slugs across both the universal and TypeScript
 * packs in one place — the same composition root that runs the gate.
 */
import { checks as typescriptChecks } from '@opensip-cli/checks-typescript';
import { checks as universalChecks } from '@opensip-cli/checks-universal';
import { describe, it, expect } from 'vitest';

/**
 * Each §8 completion invariant → the check slug(s) that enforce it. Run-currency
 * (invariant 4) is enforced by composition — `one-outcome-shape` +
 * `no-direct-stdout-in-tool-engine` — not a dedicated check (a stand-alone check
 * would only restate them; see the index). Test-pinned-only invariants (none in
 * this map) carry no check slug.
 */
const INVARIANT_CHECKS: Record<string, readonly string[]> = {
  'install-source independence': ['no-bootstrap-tool-import'],
  'one command surface': ['command-surface-parity'],
  'one outcome shape': ['one-outcome-shape'],
  'one run currency': ['one-outcome-shape', 'no-direct-stdout-in-tool-engine'],
  'input compatibility': ['tool-has-manifest'],
  'one config document': ['one-config-document'],
  'same semantics': ['same-recipe-semantics'],
  'scope isolation': ['no-module-singleton'],
  'capability by declaration': ['capability-by-manifest'],
};

const ALL_SLUGS = new Set<string>(
  [...universalChecks, ...typescriptChecks].map((c) => c.config.slug),
);

describe('parity completion-invariant index (§8)', () => {
  it('maps every §8 invariant to at least one enforcing check', () => {
    expect(Object.keys(INVARIANT_CHECKS)).toHaveLength(9);
    for (const [invariant, slugs] of Object.entries(INVARIANT_CHECKS)) {
      expect(
        slugs.length,
        `invariant '${invariant}' must name an enforcing check`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('every named enforcement check resolves to a registered fitness check', () => {
    for (const [invariant, slugs] of Object.entries(INVARIANT_CHECKS)) {
      for (const slug of slugs) {
        expect(
          ALL_SLUGS.has(slug),
          `the parity-invariant index names check '${slug}' (for '${invariant}'), but no registered check has that slug — update docs/internal/parity-invariant-index.md and this map together`,
        ).toBe(true);
      }
    }
  });
});
