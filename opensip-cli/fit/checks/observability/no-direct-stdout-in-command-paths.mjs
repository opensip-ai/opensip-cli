/**
 * Local-only observability mechanism (project layout under opensip-cli/fit/checks/).
 * NEVER ship in published packs.
 *
 * Heuristic guard: command execution paths and handlers should not write directly
 * to process.stdout/stderr except for sanctioned TTY interactive UX (readline prompts,
 * isTTY detection). Structured observability must go through logger, diagnostics bus,
 * or CommandResult so --json, traces, and runId are preserved.
 *
 * Allow-list: // observability-ok or files explicitly exempted in architecture reviews
 * (e.g. cli-ui/theme for TTY probe, configure for readline UX with documented ignore).
 */

export const noDirectStdoutInCommandPaths = {
  id: 'local:observability-no-direct-stdout-in-command-paths',
  slug: 'no-direct-stdout-in-command-paths',
  description:
    'Command handlers and execution paths must not bypass structured output (logger/diagnostics/CommandResult) with raw process.stdout/stderr writes. Interactive host UX has narrow documented exemptions.',
  tags: ['observability', 'structured-output', 'diagnostics'],
  analyze(content, filePath) {
    const violations = [];
    if (!/\.(ts|tsx)$/.test(filePath)) return violations;
    if (/node_modules|\/dist\/|\/__tests__\/|\/vendor\//.test(filePath)) return violations;
    if (/cli-ui\/src\/theme\.ts|commands\/configure\.ts/.test(filePath)) return violations; // sanctioned TTY / interactive UX

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/\/\/\s*observability-ok\b/.test(line)) continue;
      if (/process\.(stdout|stderr)\.(write|writeSync|isTTY)/.test(line) && !/isTTY/.test(line)) {
        violations.push({
          line: i + 1,
          message: `Direct process.stdout/stderr write in command or handler path. This bypasses runId, structured diagnostics, --json CommandOutcome, and OTEL correlation. Route through ToolCliContext (emitJson / render / deliverSignals) or scope.diagnostics / logger instead. Use // observability-ok only for deliberate low-level TTY probes.`,
          severity: 'warning',
        });
      }
    }
    return violations;
  },
};

export default noDirectStdoutInCommandPaths;
