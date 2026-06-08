/**
 * CommandOutcome — the standard OUTER currency wrapping every command result and
 * error (north-star §5.5, release 2.12.0).
 *
 * `SignalEnvelope` (ADR-0011) is the strong INNER currency, but the outer shape
 * drifted: run commands emitted a bare envelope, list/dashboard commands a bare
 * `CommandResult`, errors a bare `ErrorResult`, and the bootstrap bypassed all of
 * it (`process.exit` + raw stream writes). So a machine consumer could not rely on
 * one schema for every outcome — and `--json` produced nothing structured for the
 * highest-friction failures (no project, bad schema), the ones that happen before
 * a handler ever runs.
 *
 * `CommandOutcome<T>` is that one schema. It wraps the **unchanged** inner
 * envelope under `.envelope` (run commands) or the domain `CommandResult` under
 * `.data` (list/dashboard/…); an error or bootstrap outcome carries `errors` +
 * `diagnostics` with neither payload. The host ASSEMBLES it — stamping
 * `kind`/`status`/`exitCode`/`diagnostics` from the handler's pure-domain return —
 * so no tool, first-party or external, chooses its own error JSON or success
 * carrier. The handler contract does not change (the 2.11.0 command-plane spec's
 * "no handler contract change"); all the outer-shape change lands at the host
 * dispatch seam.
 *
 * This is the one user-visible breaking change before GA: `--json` now nests the
 * envelope one level down (consumers read `.envelope`/`.data`). The inner envelope
 * is byte-identical to 2.7.0+. Shipped as a 2.x minor with a migration note, like
 * the 2.7.0 `--json` change (ADR-0024).
 *
 * Types-only (the contracts charter): every field is a primitive, a sibling
 * contract type, or a readonly array thereof.
 */

import type { SignalEnvelope } from './signal-envelope.js';
import type { RunDiagnostics } from '@opensip-tools/core';


/** Outer status of a command outcome. `partial` = ran but with non-fatal gaps. */
export type CommandOutcomeStatus = 'ok' | 'error' | 'partial';

/**
 * One error attached to a `status:'error'` outcome. The structured successor to
 * the bare `ErrorResult` shape — `message` plus an optional actionable
 * `suggestion` (the field `--json` consumers most need on a bootstrap failure)
 * and an optional machine `code` (e.g. a `ToolError` code).
 */
export interface ErrorDetail {
  readonly message: string;
  readonly suggestion?: string;
  readonly code?: string;
}

/** One non-fatal warning attached to an outcome. */
export interface WarningDetail {
  readonly message: string;
  readonly code?: string;
}

/**
 * Hints the renderer consumes when materializing the outcome. RESERVED for
 * 2.12.0 — populated only with what the existing renderer already branches on
 * (`quiet`, `noColor`, `preferredFormat`); the field exists so later releases can
 * extend rendering policy without another outer-shape break. Do not invent new
 * hints here.
 */
export interface RenderHints {
  readonly quiet?: boolean;
  readonly noColor?: boolean;
  readonly preferredFormat?: 'json' | 'human';
}

/**
 * The one outer outcome shape every command — and the bootstrap — emits.
 *
 * - `kind` identifies the command/source (`'<name>.run'` for envelope output,
 *   `'<name>'` for a `CommandResult`, `'bootstrap.error'` for a pre-handler
 *   failure). Derived by the host assembler from the `CommandSpec`, not chosen by
 *   the tool.
 * - `data` (a `CommandResult`) and `envelope` (a `SignalEnvelope`) are the two
 *   mutually-informative payload slots — BOTH optional, because an error or
 *   bootstrap outcome has neither, only `errors` + `diagnostics`.
 * - `diagnostics` is attached by the host from the scope-owned diagnostics bus
 *   (north-star §5.10).
 */
export interface CommandOutcome<T = unknown> {
  readonly kind: string;
  readonly status: CommandOutcomeStatus;
  readonly exitCode: number;
  readonly data?: T;
  readonly envelope?: SignalEnvelope;
  readonly errors?: readonly ErrorDetail[];
  readonly warnings?: readonly WarningDetail[];
  readonly diagnostics?: RunDiagnostics;
  readonly renderHints?: RenderHints;
}
