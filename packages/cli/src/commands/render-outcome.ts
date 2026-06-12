/**
 * render-outcome — the SINGLE serialization seam for a {@link CommandOutcome}
 * (release 2.12.0, north-star §5.5). This is the one place an outcome reaches a
 * stream: `--json` writes the WHOLE outcome wrapper to stdout; human mode renders
 * the inner payload (`.envelope` / `.data`) through the existing Ink/text renderer
 * exactly as before.
 *
 * The three former JSON-emit sites — `cli.emitEnvelope`, `cli.emitJson`
 * (cli-context), and `emitCommandResult` (mount-result-command) — all fold into
 * this function via {@link assembleOutcome} builders, so the outer shape can never
 * re-drift across commands. The `one-outcome-shape` guardrail (Phase 5) then fails
 * CI on any stdout JSON write that bypasses this seam.
 *
 * The break: `--json` now nests the (byte-identical) envelope one level down under
 * `.envelope` (run commands) / `.data` (everything else). Human output is
 * unchanged — only the machine shape moves.
 */

import type { CommandOutcome, CommandResult } from '@opensip-cli/contracts';

/** Pretty-print width matches the legacy `formatSignalJson` / `emitJson` writers. */
const JSON_INDENT = 2;

export interface RenderOutcomeOptions {
  /** True when `--json` was requested: serialize the whole outcome to stdout. */
  readonly jsonRequested: boolean;
  /**
   * The human renderer (Ink/text) for the inner payload. Only consulted in human
   * mode; the JSON path never renders. Tools/host pass the context's `render`.
   */
  readonly render: (result: CommandResult) => Promise<void>;
}

/**
 * Render a {@link CommandOutcome}. In `--json` mode, the entire outcome is
 * serialized (the machine consumer reads `.envelope` / `.data` / `.errors`). In
 * human mode, the inner payload is rendered through the supplied renderer — the
 * envelope or the `data` result, byte-identical to the pre-2.12.0 path; an outcome
 * with neither (a pure error/bootstrap outcome) renders nothing here (its human
 * presentation is owned by the error-render path).
 */
export async function renderOutcome(
  outcome: CommandOutcome,
  opts: RenderOutcomeOptions,
): Promise<void> {
  if (opts.jsonRequested) {
    process.stdout.write(JSON.stringify(outcome, null, JSON_INDENT) + '\n');
    return;
  }
  const inner = outcome.envelope ?? outcome.data;
  if (inner !== undefined) {
    await opts.render(inner as CommandResult);
  }
}
