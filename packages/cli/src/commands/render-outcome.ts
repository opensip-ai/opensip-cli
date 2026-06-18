/**
 * render-outcome — the SINGLE serialization seam for a {@link CommandOutcome}
 * (launch, north-star §5.5). This is the one place an outcome reaches a
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
 *
 * RAW_STREAM mode ({@link renderRaw}): a command may declare `output:'raw-stream'`
 * (e.g. `sessions show --raw`) to emit the bare inner payload WITHOUT the outer
 * `CommandOutcome` wrapper — the smallest possible machine response for agents.
 * That deliberately opts out of the one-outcome shape, so its single sanctioned
 * write also lives HERE (the one stdout-JSON seam), reached via `cli.emitRaw`, not
 * hand-rolled in each command body.
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
 * envelope or the `data` result, byte-identical to the legacy path; an outcome
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

/**
 * RAW_STREAM serialization seam (north-star §5.5, `output:'raw-stream'`). Writes
 * a bare value as a single compact JSON line — the inner payload WITHOUT the
 * `CommandOutcome` wrapper. This is the one sanctioned site for an
 * intentionally-unwrapped machine response (the host binds it to `cli.emitRaw`),
 * so no command body hand-rolls `process.stdout.write(JSON.stringify(...))`.
 */
export function renderRaw(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + '\n');
}
