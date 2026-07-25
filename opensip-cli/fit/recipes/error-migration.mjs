/**
 * @fileoverview error-migration — the Plan 01 migration lane.
 *
 * The seven `error-*` checks authored in Phase A.2 ship `disabled: true`, so they never
 * run in `pnpm fit` / `pnpm fit:ci` and the dogfood gate stays green on the existing
 * backlog. This recipe is the only thing that turns them on, via `includeDisabled`.
 *
 * WHY A SEPARATE LANE RATHER THAN THE DEFAULT GATE
 * `opensip-cli.config.yml` sets `failOnErrors: 1` AND `failOnWarnings: 1`, and severity
 * maps critical/high -> error, medium/low -> warning. There is therefore no severity at
 * which a check firing on the outstanding backlog leaves the gate green. Lowering either
 * threshold to make room would weaken the guardrail for every check in the repository, so
 * the lane carries its own ratchet-only config (`.config/opensip-migration.config.yml`,
 * `failOnErrors: 0` / `failOnWarnings: 0`) and the ratchet script decides pass/fail from
 * net-new fingerprints instead.
 *
 * WHAT A GREEN LANE DOES AND DOES NOT PROVE (measured in A.1/A.2, do not overstate)
 * The shipped 226-check surface catches 0 of the 4,640 ledger sites; these seven catch 30
 * (0.65%). The lane is a RATCHET AGAINST NEW DEBT — it is authoritative for "no new
 * violation was introduced" and says almost nothing about how much of a wave's ledger
 * slice is closed. Wave completion is proven by the reviewed ledger, not by this lane.
 *
 * As each wave closes its slice, its checks drop `disabled: true`, leave `includeDisabled`
 * below, and join the default recipe — where the repo's standing `failOnErrors: 1` /
 * `failOnWarnings: 1` makes them permanent with no further configuration.
 */
import { defineRecipe } from '@opensip-cli/fitness';

/** Slugs authored in Phase A.2 against measured gaps in the shipped check surface. */
const MIGRATION_CHECKS = [
  'error-code-must-be-registered',
  'error-destructive-path-containment',
  'error-discarded-failure-detail',
  'error-floating-async-operation',
  'error-opaque-catch-collapse',
  'error-silent-empty-result',
  'error-subprocess-bounds',
];

export const errorMigrationRecipe = defineRecipe({
  name: 'error-migration',
  displayName: 'Error Migration (Plan 01)',
  description:
    'Plan 01 migration lane: runs the disabled error/resiliency checks as a net-new ratchet.',
  // ExplicitCheckSelector keys the list as `checkIds` (slugs are accepted);
  // `include` belongs to the pattern selector and is silently not the same field.
  checks: { type: 'explicit', checkIds: [...MIGRATION_CHECKS] },
  includeDisabled: [...MIGRATION_CHECKS],
  execution: { mode: 'parallel', stopOnFirstFailure: false, timeout: 60_000 },
  reporting: { format: 'table', verbose: false },
  tags: ['resilience', 'migration'],
});

/**
 * The plugin loader reads a `recipes` ARRAY from the module (`registerRecipesFromMod`);
 * a bare named export is silently ignored, so this is the load-bearing export.
 */
export const recipes = [errorMigrationRecipe];

export default errorMigrationRecipe;
