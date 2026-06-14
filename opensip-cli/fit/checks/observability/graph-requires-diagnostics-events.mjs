/**
 * Local-only observability mechanism (project layout under opensip-cli/fit/checks/).
 * NEVER ship in published packs.
 *
 * Guard: The graph engine (orchestration, rule evaluation, sharding) must emit structured
 * diagnostics events for major phases (graph build started, stage complete, rule batch,
 * errors) so `graph` runs produce observable data.
 *
 * Heuristic: orchestration/rule files that process graphs without diagnostics usage.
 * Allow // observability-ok.
 */

export const graphRequiresDiagnosticsEvents = {
  id: 'local:observability-graph-requires-diagnostics-events',
  slug: 'graph-requires-diagnostics-events',
  description:
    'Graph orchestration and rule processing must emit diagnostics events for build stages and significant events so graph runs are observable via the per-run bus.',
  tags: ['observability', 'graph', 'diagnostics'],
  analyze(content, filePath) {
    const violations = [];
    if (!/graph\/engine\/src\/(cli|orchestrate|rules)/.test(filePath)) return violations;
    if (/\.test\.ts$/.test(filePath)) return violations;
    if (/\/\/\s*observability-ok\b/.test(content)) return violations;

    const processesGraph =
      /orchestrate|runGraph|buildGraph|processGraph|forEachRule|evaluateRules|sharding/.test(
        content,
      );
    const usesDiagnostics =
      /diagnostics\.(event|counter|emit)|scope\.diagnostics|currentScope\(\)\?\.diagnostics/.test(
        content,
      );

    if (processesGraph && !usesDiagnostics) {
      violations.push({
        line: 1,
        message: `Graph engine code processes graphs but does not emit via diagnostics bus. Add events for stages (e.g. "graph.stage", "graph.rule-batch") for observability of long graph runs in --json / traces.`,
        severity: 'warning',
      });
    }
    return violations;
  },
};

export default graphRequiresDiagnosticsEvents;
