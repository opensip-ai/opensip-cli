/**
 * @fileoverview Tool engines must not write run output directly to stdout.
 *
 * ADR-0011 ("signal output currency"): a tool run emits a `SignalEnvelope`
 * and RETURNS it; the CLI composition root maps flags → (formatter × sink)
 * and owns rendering + delivery. A tool engine that writes its run output
 * straight to stdout bypasses that seam — the output never becomes a signal,
 * never reaches a formatter, never honours `--json` / `--report-to` / cloud
 * egress. dependency-cruiser catches a tool→formatter/sink IMPORT
 * (`tool-engines-no-output-formatters` / `-no-output-sinks`); this check
 * catches the call-shape that has no import to catch:
 * `process.stdout.write(...)` / `console.log(...)`.
 *
 * SCOPE — stdout, not stderr. The contract under enforcement is the *run
 * output* channel (stdout). stderr is the legitimate diagnostics channel:
 * error messages, warnings, and human-facing failure notices are not run
 * output and flow there by design. Flagging stderr would force a blanket
 * exemption on every error-handling path and dilute the gate to "remember
 * the ignore directive", so this check deliberately targets the stdout
 * channel only (`process.stdout.write`, `console.log`/`.info`/`.debug`).
 *
 * SCOPE — tool engines only. The check fires only on
 * `packages/{fitness,graph,simulation}/engine/src/**`. Other packages (the
 * CLI composition root, output sinks, dashboard) legitimately own stdout.
 * It runs against the dogfood `backend` target (concerns: backend), which
 * spans every package's src; the path guard below narrows it to tool
 * engines.
 *
 * LEGITIMATE direct stdout in a tool engine (subprocess IPC, machine `--json`
 * paths that deliberately bypass the render seam, auxiliary-subcommand status
 * lines) is exempted per-file via `@fitness-ignore-file
 * no-direct-stdout-in-tool-engine` with a justification comment — e.g. the
 * shard-worker IPC protocol (`graph/engine/src/cli/shard-worker.ts`).
 */
import { defineCheck, type CheckViolation } from '@opensip-tools/fitness';

/**
 * Resolved-path fragment that identifies a tool-engine source file. The
 * check only applies inside the three tool engines; everything else (CLI
 * root, output package, dashboard, core) may own stdout.
 */
const TOOL_ENGINE_PATH = /packages\/(fitness|graph|simulation)\/engine\/src\//;

/**
 * stdout run-output call shapes. `process.stdout.write(` is the explicit
 * channel; `console.log`/`.info`/`.debug` route to stdout under the hood.
 * `console.error`/`.warn` are intentionally absent — stderr is the
 * diagnostics channel (see the file header).
 */
const STDOUT_PATTERNS: readonly RegExp[] = [
  /\bprocess\.stdout\.write\s*\(/,
  /\bconsole\.(?:log|info|debug)\s*\(/,
];

/**
 * Pure analysis function. Exported so unit tests can exercise the detection
 * logic without standing up the full Check framework. Operates on
 * `strip-strings`-filtered content so the literal text "process.stdout" inside
 * a string or doc-comment example does not false-fire — only real call sites
 * are flagged.
 */
export function analyzeDirectStdout(content: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const lines = content.split('\n');
  for (const [i, line] of lines.entries()) {
    for (const pattern of STDOUT_PATTERNS) {
      if (pattern.test(line)) {
        violations.push({
          message:
            'Tool engines must not write run output directly to stdout. Return a ' +
            'SignalEnvelope and let the CLI composition root render/deliver it ' +
            '(cli.render / cli.emitJson / cli.deliverSignals / cli.writeSarif).',
          severity: 'error',
          line: i + 1,
          suggestion:
            'Route the output through the ToolCliContext seam, or — if this is ' +
            'subprocess IPC / a deliberate machine path — add ' +
            '`@fitness-ignore-file no-direct-stdout-in-tool-engine` with a ' +
            'justification comment.',
        });
        break;
      }
    }
  }
  return violations;
}

export const noDirectStdoutInToolEngine = defineCheck({
  id: '9a2a9d7a-2e40-4adf-b682-534c3412d4da',
  slug: 'no-direct-stdout-in-tool-engine',
  description: 'Tool engines must emit a SignalEnvelope, not write run output to stdout (ADR-0011)',
  scope: { languages: ['typescript'], concerns: ['backend'] },
  tags: ['architecture', 'quality'],
  fileTypes: ['ts', 'tsx'],
  // strip-strings so "process.stdout"/"console.log" appearing inside string
  // literals (e.g. error messages, code examples in JSDoc) do not false-fire;
  // only real call expressions survive the filter.
  contentFilter: 'strip-strings',
  analyze: (content, filePath) => {
    // The contract is tool-engine-scoped. The dogfood `backend` target spans
    // every package's src; narrow to the three tool engines here.
    if (!TOOL_ENGINE_PATH.test(filePath)) return [];
    return analyzeDirectStdout(content);
  },
});
