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

import { defineCheck } from '@opensip-cli/fitness';

export const requireDiagnosticsLifecycleEvents = defineCheck({
  id: '583c34a9-e417-4bbe-8b53-f04833334071',
  slug: 'require-diagnostics-lifecycle-events',
  description:
    'Command handlers, bootstrap, and major execution phases must emit structured diagnostics events (lifecycle, execute, deliver, error, etc.) so runs are observable even without full OTEL. Complements spans.',
  tags: ['observability', 'diagnostics', 'lifecycle'],
  analyze(content, filePath) {
    const violations = [];
    if (!/\.(ts|tsx)$/.test(filePath) || /\.d\.ts$/.test(filePath)) return violations;
    if (
      /node_modules|\/dist\/|\/__tests__\/|\.test\.ts$|resilience\/|observability\//.test(filePath)
    )
      return violations;

    // Only the ACTUAL command-dispatch / run-lifecycle machinery is in scope —
    // the single output-dispatch seam and the Commander pre/post-action hooks.
    // (The old "any file with the word handler/execute" trigger flagged error
    // classes, formatters, types, and builders — pure false positives.)
    // Match the ACTUAL dispatch/hook-registration sites (where the lifecycle
    // runs), not files that merely import/re-export/mention them — `dispatchOutput`
    // is the single output-dispatch seam; `program.hook(...)` is the Commander
    // pre/post-action registration. (`installPreActionHook` was dropped: it
    // matched the barrel re-export + the call site + a JSDoc comment, none of
    // which is the emitting body — `pre-action-hook.ts` itself matches `program.hook`.)
    const lifecyclePatterns = [
      /\bdispatchOutput\s*\(/,
      /\bprogram\.hook\s*\(/,
      /\.hook\s*\(\s*['"](?:preAction|postAction)['"]/,
    ];
    const lines = content.split(/\r?\n/);
    const matchIdx = lines.findIndex((l) => lifecyclePatterns.some((re) => re.test(l)));
    if (matchIdx === -1) return violations;

    const hasDiagnosticsEmit =
      /diagnostics[?.]*\.(event|counter|emit|snapshot)|scope\.diagnostics/.test(content);
    if (hasDiagnosticsEmit) return violations;
    if (/\/\/\s*observability-ok\b/.test(lines[matchIdx])) return violations;

    violations.push({
      line: matchIdx + 1,
      message: `Command-dispatch / run-lifecycle path lacks any diagnostics.event/counter emit. Every run should produce observable lifecycle data (start, execute, complete/error, deliver) via the scope-owned DiagnosticsBus so --json and traces have context. Add at least one structured event or // observability-ok with justification.`,
      severity: 'warning',
    });
    return violations;
  },
});

export default requireDiagnosticsLifecycleEvents;
