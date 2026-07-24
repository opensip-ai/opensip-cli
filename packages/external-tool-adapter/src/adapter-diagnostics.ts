/**
 * @fileoverview Bounded diagnostics emission for the external-tool-adapter
 * substrate (OBS-ADAPTER).
 *
 * Lifecycle decisions (resolve / run / artifact / completion / fault) used to
 * go only through `cli.logger`, which is suppressed under `--json` without
 * `--debug`. Every thin `tool-*` scanner inherited a machine-output blind
 * spot. This module is the single owner: each decision is stamped onto the
 * scope {@link DiagnosticsBus} (credential-safe, bounded) AND still logged
 * for human/debug operators.
 *
 * Worker dispatch folds the bus snapshot back into the host (ADR-0174), so
 * adapter events reach `--json` `diagnostics.events` on both in-process and
 * dispatched paths.
 */

import { basename } from 'node:path';

import type { DiagnosticLevel, DiagnosticPhase, ToolCliContext } from '@opensip-cli/core';

/** Logger + diagnostics `module` tag for every adapter decision. */
export const ADAPTER_DIAG_MODULE = 'external-tool-adapter';

/** Stable `data.source` so worker `origin` re-stamping cannot erase substrate identity. */
export const ADAPTER_DIAG_SOURCE = 'external-tool-adapter';

/** Stable event names emitted by the scan loop / completion path. */
export const ADAPTER_DIAG_EVT = {
  GATE_CONFIG_ERROR: 'adapter.gate.config_error',
  BINARY_RESOLVED: 'adapter.binary.resolved',
  SCAN_FAULTED: 'adapter.scan.faulted',
  SCAN_EMPTY_NOOP: 'adapter.scan.empty_noop',
  ARTIFACT_STORED: 'adapter.artifact.stored',
  SCAN_COMPLETED: 'adapter.scan.completed',
} as const;

/** One of the stable {@link ADAPTER_DIAG_EVT} lifecycle event names. */
export type AdapterDiagEvt = (typeof ADAPTER_DIAG_EVT)[keyof typeof ADAPTER_DIAG_EVT];

/** Inputs for {@link emitAdapterDecision} — one adapter lifecycle decision. */
export interface AdapterDecisionInput {
  /** Tool CLI context (logger + optional scope diagnostics bus). */
  readonly cli: ToolCliContext;
  /** Short tool id (e.g. `gitleaks`). */
  readonly tool: string;
  /** Stable machine event name. */
  readonly evt: AdapterDiagEvt;
  /** Human-readable decision summary (no secrets). */
  readonly message: string;
  /** Lifecycle phase for the diagnostics bus. */
  readonly phase: DiagnosticPhase;
  /** Severity level for the diagnostics bus. */
  readonly level: DiagnosticLevel;
  /**
   * Open decision bag. Paths are reduced to basenames; strings are length-capped;
   * only JSON-safe scalars/shallow records are kept. Never pass raw stderr or
   * credential material — redact first at the call site.
   */
  readonly data?: Readonly<Record<string, unknown>>;
  /** Parallel structured-log level (defaults from {@link DiagnosticLevel}). */
  readonly log?: 'debug' | 'info' | 'warn' | 'error';
}

const MAX_STRING = 200;
const MAX_KEYS = 16;

/**
 * Record one adapter lifecycle decision on the diagnostics bus and the logger.
 * Safe when `scope.diagnostics` is absent (lean test stubs).
 */
export function emitAdapterDecision(input: AdapterDecisionInput): void {
  const { cli, tool, evt, message, phase, level } = input;
  const bounded = boundDecisionData({ tool, evt, source: ADAPTER_DIAG_SOURCE, ...input.data });

  cli.scope.diagnostics?.event(phase, level, message, bounded);
  cli.scope.diagnostics?.counter(`adapter.${evt}`, 1);

  const logLevel = input.log ?? defaultLogLevel(level);
  cli.logger[logLevel]({
    evt,
    module: ADAPTER_DIAG_MODULE,
    tool,
    ...bounded,
  });
}

function defaultLogLevel(level: DiagnosticLevel): 'info' | 'warn' | 'error' | 'debug' {
  if (level === 'error') return 'error';
  if (level === 'warn') return 'warn';
  if (level === 'debug') return 'debug';
  return 'info';
}

/**
 * Bound an open decision bag for the diagnostics plane: basenames for path-like
 * keys, string length cap, key cap, scalars only (plus one-level plain records
 * of scalars). Drops functions, arrays, and deep nests.
 */
export function boundDecisionData(
  data: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(data)) {
    if (count >= MAX_KEYS) break;
    if (value === undefined) continue;
    const bounded = boundLeaf(key, value);
    if (bounded === undefined) continue;
    out[key] = bounded;
    count += 1;
  }
  return out;
}

function boundLeaf(key: string, value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return boundString(key, value);
  if (typeof value === 'object' && !Array.isArray(value)) {
    return boundShallowRecord(value as Record<string, unknown>);
  }
  return undefined;
}

function boundString(key: string, value: string): string {
  if (isPathLikeKey(key)) return basename(value);
  if (value.length > MAX_STRING) return `${value.slice(0, MAX_STRING - 1)}…`;
  return value;
}

function boundShallowRecord(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const nested: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(value)) {
    if (n >= MAX_KEYS) break;
    const leaf = boundScalarLeaf(k, v);
    if (leaf === undefined) continue;
    nested[k] = leaf;
    n += 1;
  }
  return Object.keys(nested).length > 0 ? nested : undefined;
}

function boundScalarLeaf(key: string, value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return boundString(key, value);
  return undefined;
}

function isPathLikeKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower === 'path' || lower.endsWith('path') || lower === 'file' || lower.endsWith('file');
}
