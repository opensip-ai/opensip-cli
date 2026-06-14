/**
 * Local-only observability mechanism (project layout under opensip-cli/fit/checks/).
 * NEVER ship in published packs.
 *
 * Guard: mounted command paths and major lifecycle phases (bootstrap, tool load,
 * execution, delivery, error) should emit at least one structured diagnostics event
 * (via scope.diagnostics.event or counter) so every run produces observable lifecycle
 * data on CommandOutcome. Complements existing "hot-paths-require-spans" and the
 * diagnostics bus itself.
 *
 * This is a heuristic (looks for "diagnostics\." or "diagnostics\." near command/handler
 * code). Allow // observability-ok.
 */

export const requireDiagnosticsLifecycleEvents = {
  id: 'local:observability-require-diagnostics-lifecycle-events',
  slug: 'require-diagnostics-lifecycle-events',
  description:
    'Command handlers, bootstrap, and major execution phases must emit structured diagnostics events (lifecycle, execute, deliver, error, etc.) so runs are observable even without full OTEL. Complements spans.',
  tags: ['observability', 'diagnostics', 'lifecycle'],
  analyze(content, filePath) {
    const violations = [];
    if (!/\.(ts|tsx)$/.test(filePath)) return violations;
    if (/node_modules|\/dist\/|\/__tests__\/|resilience\/|observability\//.test(filePath))
      return violations;

    const hasCommandOrHandler =
      /mountCommand|execute|handler|CommandSpec|preAction|postAction/.test(content);
    const hasDiagnosticsEmit = /diagnostics\.(event|counter|emit|snapshot)|scope\.diagnostics/.test(
      content,
    );

    if (hasCommandOrHandler && !hasDiagnosticsEmit) {
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (/mountCommand|execute|handler|CommandSpec|preAction|postAction/.test(lines[i])) {
          if (!/\/\/\s*observability-ok\b/.test(lines[i])) {
            violations.push({
              line: i + 1,
              message: `Command/handler path appears to lack any diagnostics.event/counter emit. Every run should produce observable lifecycle data (start, execute, complete/error, deliver) via the scope-owned DiagnosticsBus so --json and traces have context. Add at least one structured event or // observability-ok with justification.`,
              severity: 'warning',
            });
          }
          break;
        }
      }
    }
    return violations;
  },
};

export default requireDiagnosticsLifecycleEvents;
