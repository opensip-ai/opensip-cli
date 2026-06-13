/**
 * BootstrapError — a typed pre-handler failure thrown by the `preAction` guards
 * instead of writing to a stream + `process.exit()` (launch, §4.7).
 *
 * Bootstrap failures (no project, schema-too-old, config-resolve, tool-init) used
 * to bypass the central renderer: each guard wrote its own message and called
 * `process.exit(n)`, so `--json` produced nothing structured for exactly the
 * highest-friction failures. Now each guard THROWS a `BootstrapError`, and one
 * top-level boundary (the `parseAsync().catch`) renders it through the same
 * `CommandOutcome` seam as every other result — `--json` emits a structured,
 * suggestion-bearing `bootstrap.error` outcome; human mode writes the unchanged
 * formatted message to stderr (byte-identical to the legacy bytes).
 *
 * The error carries BOTH a clean `message` (for the `--json` `errors[].message`)
 * and the original multi-line `humanMessage` (for the byte-identical stderr path),
 * plus an explicit `exitCode` — schema/no-project/config are `2`, a tool-init
 * failure is `1` — so the boundary sets the exit code from the error itself rather
 * than re-deriving it.
 */

import { ToolError } from '@opensip-cli/core';

export interface BootstrapErrorInput {
  /** Clean, single-line message for the structured `--json` outcome. */
  readonly message: string;
  /**
   * The exact multi-line text the guard used to write to stderr. The human
   * boundary writes `${humanMessage}\n` verbatim — preserving the legacy
   * bytes — instead of routing through the Ink error renderer.
   */
  readonly humanMessage: string;
  /** Actionable next step surfaced in the structured outcome's `errors[].suggestion`. */
  readonly suggestion?: string;
  /** Process exit code (2 for config/no-project, 1 for a tool-init failure). */
  readonly exitCode: number;
}

export class BootstrapError extends ToolError {
  readonly humanMessage: string;
  readonly suggestion: string | undefined;
  readonly exitCode: number;

  constructor(input: BootstrapErrorInput) {
    super(input.message, 'CONFIGURATION.BOOTSTRAP');
    this.name = 'BootstrapError';
    this.humanMessage = input.humanMessage;
    this.suggestion = input.suggestion;
    this.exitCode = input.exitCode;
  }
}
