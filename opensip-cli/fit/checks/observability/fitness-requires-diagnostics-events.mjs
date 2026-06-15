/**
 * Local-only observability mechanism (project layout under opensip-cli/fit/checks/).
 * NEVER ship in published packs.
 *
 * Guard: the fitness run lifecycle is owned by ONE method —
 * `executeRecipeInScope` on FitnessRecipeService (the body that runs a recipe's
 * checks inside a RunScope). The host emits COMMAND-level lifecycle; only the
 * recipe engine knows its INTERNAL lifecycle (which recipe ran, how many checks
 * passed/failed/errored). So that owner must emit at least one run-level
 * diagnostics event on the per-run DiagnosticsBus (`scope.diagnostics.event/
 * counter`) so every `fit` run is observable on the `--json` CommandOutcome /
 * OTEL trace.
 *
 * This is a REGRESSION ratchet, not a coarse keyword scan: it fires on exactly
 * the file that DEFINES the lifecycle owner, not on the executors / processors /
 * profilers / type files that merely contain words like "runOneCheck" (those
 * were the false positives the original heuristic produced). Allow with a
 * `// observability-ok` line if the owner legitimately delegates emission.
 */

import { defineCheck } from '@opensip-cli/fitness';

export const fitnessRequiresDiagnosticsEvents = defineCheck({
  id: '08af4d26-54c2-4c2e-bf39-fb459fe7f61f',
  slug: 'fitness-requires-diagnostics-events',
  description:
    'The fitness run lifecycle owner (executeRecipeInScope) must emit at least one run-level diagnostics event so fit runs are observable via the per-run DiagnosticsBus (--json / traces).',
  tags: ['observability', 'fitness', 'diagnostics'],
  analyze(content, filePath) {
    const violations = [];
    if (!/\.ts$/.test(filePath) || /\.d\.ts$/.test(filePath) || /\.test\.ts$/.test(filePath))
      return violations;

    // Anchor on the file that DEFINES the run-lifecycle owner —
    // `executeRecipeInScope`. Helpers, executors, and type files do not match,
    // so only the one owning file is in scope.
    const isRunOwner = /\bexecuteRecipeInScope\s*\(/.test(content);
    if (!isRunOwner) return violations;
    if (/\/\/\s*observability-ok\b/.test(content)) return violations;

    const usesDiagnostics =
      /\.diagnostics\.(event|counter|emit)|scope\.diagnostics|currentScope\(\)\?\.diagnostics/.test(
        content,
      );
    if (usesDiagnostics) return violations;

    violations.push({
      line: 1,
      message: `The fitness run lifecycle owner (executeRecipeInScope) does not emit any diagnostics event. Add at least one run-level event (e.g. recipeScope.diagnostics.event('execute', 'debug', 'recipe session started', {...})) so fit runs surface lifecycle data on the --json CommandOutcome / OTEL trace, or // observability-ok with justification.`,
      severity: 'warning',
    });
    return violations;
  },
});

export default fitnessRequiresDiagnosticsEvents;
