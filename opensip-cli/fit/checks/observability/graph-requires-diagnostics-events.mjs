/**
 * Local-only observability mechanism (project layout under opensip-cli/fit/checks/).
 * NEVER ship in published packs.
 *
 * Guard: the graph run lifecycle is owned by ONE entry point — `executeGraph`
 * (the orchestration function `tool.ts` invokes). The host emits COMMAND-level
 * lifecycle (mount-command-spec / pre-action hook); only the engine knows its
 * INTERNAL lifecycle (requested engine, resolved mode, shard fan-out, build
 * complete). So the run entry must emit at least one run-level diagnostics event
 * on the per-run DiagnosticsBus (`scope.diagnostics.event/counter`) so every
 * `graph` run is observable on the `--json` CommandOutcome / OTEL trace.
 *
 * This is a REGRESSION ratchet, not a coarse keyword scan: it fires on exactly
 * the file that DEFINES the run entry, not on the dozens of helper / type / UI /
 * registry files that merely contain words like "orchestrate" or "buildGraph"
 * (those were the false positives the original heuristic produced). Allow with a
 * `// observability-ok` line if the entry legitimately delegates emission.
 */

import { defineCheck } from '@opensip-cli/fitness';

export const graphRequiresDiagnosticsEvents = defineCheck({
  id: '451197d9-f051-4dc8-8aca-ec98a154cea1',
  slug: 'graph-requires-diagnostics-events',
  description:
    'The graph run entry point (executeGraph) must emit at least one run-level diagnostics event so graph runs are observable via the per-run DiagnosticsBus (--json / traces).',
  tags: ['observability', 'graph', 'diagnostics'],
  analyze(content, filePath) {
    const violations = [];
    if (!/\.ts$/.test(filePath) || /\.d\.ts$/.test(filePath) || /\.test\.ts$/.test(filePath))
      return violations;

    // Anchor on the file that DEFINES the run entry — `export async function
    // executeGraph`. A re-export (`export { executeGraph }`) or an import does
    // not match, so only the one owning file is in scope.
    const isRunEntry = /export\s+async\s+function\s+executeGraph\b/.test(content);
    if (!isRunEntry) return violations;
    if (/\/\/\s*observability-ok\b/.test(content)) return violations;

    const usesDiagnostics =
      /\.diagnostics\.(event|counter|emit)|scope\.diagnostics|currentScope\(\)\?\.diagnostics/.test(
        content,
      );
    if (usesDiagnostics) return violations;

    violations.push({
      line: 1,
      message: `The graph run entry (executeGraph) does not emit any diagnostics event. Add at least one run-level event (e.g. scope.diagnostics.event('execute', 'debug', 'graph build started', {...})) so graph runs surface lifecycle data on the --json CommandOutcome / OTEL trace, or // observability-ok with justification.`,
      severity: 'warning',
    });
    return violations;
  },
});

export default graphRequiresDiagnosticsEvents;
