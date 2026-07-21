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
 *
 * ADR-0175: if primary `JSON.stringify` throws (hostile envelope residual, etc.),
 * write a minimal always-serializable fallback document first so a `--json` run
 * never emits zero stdout, then rethrow so the host exit plane can mark failure.
 */

import { EXIT_CODES, type CommandOutcome, type CommandResult } from '@opensip-cli/contracts';
import { isEmbeddedRender } from '@opensip-cli/core';

/** Pretty-print width matches the legacy `formatSignalJson` / `emitJson` writers. */
const JSON_INDENT = 2;

/** Stable code for the guaranteed fallback document (ADR-0175). */
export const OUTCOME_SERIALIZE_FAILED_CODE = 'SYSTEM.OUTPUT.SERIALIZE_FAILED';

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
  // Suite steps execute in embedded-render mode. Keep the suppression at this
  // host-owned serialization boundary as well as the Ink/static render seams:
  // a command-result step with the shared `--json` flag would otherwise bypass
  // its capturing ToolCliContext and write a second document directly to stdout.
  if (isEmbeddedRender()) return;
  if (opts.jsonRequested) {
    writeJsonDocument(outcome, () => buildOutcomeSerializeFallback(outcome));
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
  writeJsonDocument(value, () => buildRawSerializeFallback(value), /* pretty */ false);
}

/**
 * Write JSON to stdout. On primary serialization failure, write the guaranteed
 * fallback document, then rethrow so the output plane can flip a successful
 * run to RUNTIME_ERROR (ADR-0175).
 */
function writeJsonDocument(value: unknown, buildFallback: () => unknown, pretty = true): void {
  const space = pretty ? JSON_INDENT : undefined;
  try {
    process.stdout.write(JSON.stringify(value, null, space) + '\n');
  } catch (error) {
    // Fallback is constructed from primitives only and must never throw.
    process.stdout.write(JSON.stringify(buildFallback(), null, space) + '\n');
    throw error;
  }
}

/**
 * Minimal always-serializable outcome used when the primary document cannot be
 * stringified. Preserves the attempted `kind` for correlation; forces
 * `status:'error'` and RUNTIME_ERROR so the document does not claim success.
 */
export function buildOutcomeSerializeFallback(outcome: CommandOutcome): CommandOutcome {
  const reason = 'CommandOutcome JSON serialization failed';
  return {
    kind:
      typeof outcome.kind === 'string' && outcome.kind.length > 0 ? outcome.kind : 'command.error',
    status: 'error',
    exitCode: EXIT_CODES.RUNTIME_ERROR,
    errors: [
      {
        message: reason,
        code: OUTCOME_SERIALIZE_FAILED_CODE,
      },
    ],
  };
}

/** Compact fallback for RAW_STREAM when the bare value is unserializable. */
export function buildRawSerializeFallback(value: unknown): {
  readonly error: {
    readonly code: typeof OUTCOME_SERIALIZE_FAILED_CODE;
    readonly message: string;
    readonly valueType: string;
  };
} {
  return {
    error: {
      code: OUTCOME_SERIALIZE_FAILED_CODE,
      message: 'RAW_STREAM JSON serialization failed',
      valueType: value === null ? 'null' : typeof value,
    },
  };
}
