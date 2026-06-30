/**
 * output-plane — the host's machine-output + exit-code plane
 * (host-owned-run-timing Phase 6 §6.1).
 *
 * Owns:
 *  - the single `process.exitCode` write path (`setExitCode`) and the captured
 *    in-memory mirror (`getExitCode`), so the run's exit code has exactly one
 *    author;
 *  - the four `--json`-path emit seams (`emitJson`, `emitEnvelope`, `emitError`,
 *    `emitRaw`), each wrapping the tool's pure-domain payload in a
 *    `CommandOutcome` through the single {@link renderOutcome} serialization seam
 *    (launch §5.5) — except `emitRaw`, which deliberately writes the unwrapped
 *    payload via {@link renderRaw}.
 *
 * Extracted verbatim from `buildToolCliContext`: the behaviour (outcome
 * builders, render-failure fallbacks, exit-code threading) is unchanged — this
 * module just gives the concern its own home and a narrow, testable surface.
 */

import { logger as defaultLogger, type Logger, type ToolCliContext } from '@opensip-cli/core';

import {
  outcomeFromEnvelope,
  outcomeFromErrorMessage,
  outcomeFromResult,
} from '../commands/assemble-outcome.js';
import { renderOutcome, renderRaw } from '../commands/render-outcome.js';

import { stampDeclaredInputs } from './declared-inputs.js';

import type { CommandResult, SignalEnvelope } from '@opensip-cli/contracts';

/** Structured-log `module` tag for the output plane. */
const MODULE_TAG = 'cli:output-plane';

/** Stable dependencies the output plane captures. */
export interface OutputPlaneDeps {
  /** The human renderer (Ink/text) the emit seams pass through on the non-JSON path. */
  readonly render: (result: CommandResult) => Promise<void>;
  readonly logger?: Logger;
}

/** The output plane's public surface. */
export interface OutputPlane {
  /** The single `process.exitCode` write path (mirrors into the captured value). */
  readonly setExitCode: (code: number) => void;
  /** The captured exit code, or `undefined` if never set this run. */
  readonly getExitCode: () => number | undefined;
  /** The four `ToolCliContext` machine-output seams, ready to spread into the context. */
  readonly emits: Pick<ToolCliContext, 'emitJson' | 'emitEnvelope' | 'emitError' | 'emitRaw'>;
}

export function createOutputPlane(deps: OutputPlaneDeps): OutputPlane {
  const log = deps.logger ?? defaultLogger;
  let exitCode: number | undefined;

  const setExitCode = (code: number): void => {
    exitCode = code;
    process.exitCode = code;
  };

  const emits: OutputPlane['emits'] = {
    // launch (§5.5): every machine output the host emits is wrapped in a
    // `CommandOutcome` through the single `renderOutcome` seam — `emitJson`
    // (general-purpose `.data`), `emitEnvelope` (run `.envelope`), and
    // `emitError` (`status:'error'` `.errors`). The host STAMPS the outer
    // currency; the tool only hands over its pure-domain payload. `--json` is
    // implicit here: these seams are only ever called on the `--json` path, so
    // they always serialize the outcome (the `render` arg is inert).
    //
    // Errors during renderOutcome are attached to a catch so they are not
    // completely swallowed by the `void` (they surface in logs and as
    // unhandled-rejection diagnostics instead of silent loss).
    emitJson: (value) => {
      renderOutcome(outcomeFromResult(value, exitCode ?? 0), {
        jsonRequested: true,
        render: deps.render,
      }).catch((error) => {
        // Primary machine output path failed — do not swallow silently.
        // Only force a non-success exit if the primary run had not already
        // decided on a failure code (preserve specific codes like REPORT_FAILED,
        // RUNTIME_ERROR, etc.). Render failure of the outcome is secondary.
        if ((exitCode ?? 0) === 0) {
          setExitCode(1);
        }
        log.error({
          evt: 'cli.emit_json.render_failed',
          module: MODULE_TAG,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    emitEnvelope: (envelope) => {
      renderOutcome(
        outcomeFromEnvelope(stampDeclaredInputs(envelope as SignalEnvelope), exitCode ?? 0),
        {
          jsonRequested: true,
          render: deps.render,
        },
      ).catch((error) => {
        if ((exitCode ?? 0) === 0) {
          setExitCode(1);
        }
        log.error({
          evt: 'cli.emit_envelope.render_failed',
          module: MODULE_TAG,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    // Structured error machine-output (retires the bare `emitJson({ error })`
    // shape the `one-outcome-shape` guardrail forbids). The handler hands a
    // diagnosed failure (message + exit code, optional suggestion); the host
    // wraps it as a `status:'error'` outcome. `exitCode` is also threaded to
    // `setExitCode` so the process exit and the reported outcome agree.
    emitError: (detail) => {
      setExitCode(detail.exitCode);
      renderOutcome(
        outcomeFromErrorMessage({
          message: detail.message,
          exitCode: detail.exitCode,
          ...(detail.suggestion === undefined ? {} : { suggestion: detail.suggestion }),
          ...(detail.code === undefined ? {} : { code: detail.code }),
          ...(detail.diagnostic === undefined ? {} : { diagnostic: detail.diagnostic }),
        }),
        { jsonRequested: true, render: deps.render },
      ).catch((error) => {
        // Even error emission failing is fatal for the json contract.
        // Only force 1 if the error detail itself indicated success (edge).
        if ((exitCode ?? 0) === 0) {
          setExitCode(1);
        }
        log.error({
          evt: 'cli.emit_error.render_failed',
          module: MODULE_TAG,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    // RAW_STREAM seam (§5.5): emit the bare, unwrapped value for a command that
    // declares `output:'raw-stream'` (e.g. `sessions show --raw`). The single
    // sanctioned write lives in `renderRaw` (the one stdout-JSON seam), so the
    // command body never hand-rolls `process.stdout.write(JSON.stringify(...))`.
    emitRaw: (value) => renderRaw(value),
  };

  return {
    setExitCode,
    getExitCode: () => exitCode,
    emits,
  };
}
