/**
 * Local-only observability mechanism (project layout under opensip-cli/fit/checks/).
 * NEVER ship in published packs.
 *
 * Guard: The fitness check execution engine (run-one-check, sequential/parallel execution,
 * recipes) must emit structured diagnostics events for check lifecycle (started, completed,
 * errored, progress) so that long-running `fit` invocations produce observable per-check
 * data on the DiagnosticsBus / CommandOutcome.
 *
 * Heuristic looks for execution of checks without nearby diagnostics usage in the runner files.
 * Allow // observability-ok.
 */

export const fitnessRequiresDiagnosticsEvents = {
  id: 'local:observability-fitness-requires-diagnostics-events',
  slug: 'fitness-requires-diagnostics-events',
  description:
    'Fitness check runners and execution services must emit diagnostics events (check started/completed/errored) so fit runs are observable at check granularity via the per-run bus.',
  tags: ['observability', 'fitness', 'diagnostics'],
  analyze(content, filePath) {
    const violations = [];
    if (!/fitness\/engine\/src\/(recipes|cli\/fit|framework)/.test(filePath)) return violations;
    if (/\.test\.ts$/.test(filePath)) return violations;
    if (/\/\/\s*observability-ok\b/.test(content)) return violations;

    const runsChecks =
      /runOneCheck|executeCheck|forEachCheck|runChecks|check execution|sequentialExecution|parallelExecution/.test(
        content,
      );
    const usesDiagnostics =
      /diagnostics\.(event|counter|emit)|scope\.diagnostics|currentScope\(\)\?\.diagnostics/.test(
        content,
      );

    if (runsChecks && !usesDiagnostics) {
      violations.push({
        line: 1,
        message: `Fitness execution code runs checks but does not appear to emit via diagnostics bus. Add at least 'scope.diagnostics?.event("check", "info", ...)' or similar for lifecycle observability. This affects --json outcomes and tracing for long fit runs.`,
        severity: 'warning',
      });
    }
    return violations;
  },
};

export default fitnessRequiresDiagnosticsEvents;
