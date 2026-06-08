/**
 * host-env-specs — the CLI's environment-variable surface (release 2.12.0, §5.12).
 *
 * The env surface is governed exactly like the config document: every variable is
 * declared as an immutable {@link EnvVarSpec} and read through the {@link EnvRegistry}
 * primitive, so it can be documented (the generated env-surface reference) and
 * deprecated coherently. The `env-via-registry` guardrail fails CI on any raw
 * `process.env` read outside the registry.
 *
 * This module owns the CLI-layer infra variables (telemetry + update-notifier) and
 * AGGREGATES the per-package specs (config, graph) plus the documented pre-scope
 * exceptions into one `describeHostEnv()` for the reference doc — the CLI is the
 * composition root, so it is the one place that can name every layer's specs.
 *
 * Pre-scope exceptions: the terminal-theme color vars (`@opensip-tools/cli-ui` has
 * no `core` dependency and resolves colors before any scope exists) and
 * `NODE_OPTIONS` (the graph heap-preflight mutates it before any opensip module
 * loads) are read raw at their sites. They are declared here for documentation
 * only and allow-listed by the `env-via-registry` guardrail.
 */

import { CONFIG_ENV_SPECS } from '@opensip-tools/config';
import { EnvRegistry, type EnvVarSpec } from '@opensip-tools/core';
import { GRAPH_ENV_SPECS } from '@opensip-tools/graph';

/** CLI-layer infra variables: OpenTelemetry + the update-notifier opt-outs. */
export const CLI_ENV_SPECS: readonly EnvVarSpec<unknown>[] = [
  {
    canonical: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    docs: 'OTLP/HTTP endpoint. When set, the CLI enables OpenTelemetry tracing; unset is a hard no-op.',
  },
  {
    canonical: 'TRACEPARENT',
    docs: 'W3C traceparent of a parent trace (read only when telemetry is on); run spans nest under it.',
  },
  {
    canonical: 'OPENSIP_NO_UPDATE',
    coerce: (raw) => raw.length > 0,
    default: false,
    docs: 'Set to any non-empty value to skip the CLI update check.',
  },
  {
    canonical: 'NO_UPDATE_NOTIFIER',
    coerce: (raw) => raw.length > 0,
    default: false,
    docs: 'npm-convention update-notifier opt-out; honoured as an equivalent of OPENSIP_NO_UPDATE.',
  },
];

/** The composed CLI-layer registry. Telemetry + update-notifier read through it. */
// @allow-module-singleton EnvRegistry is IMMUTABLE — a constant spec table + on-demand process.env reads; it holds no per-run mutable state, so it is not the scope-isolation hazard no-module-singleton targets (spec §5.12 resolved decision: the env definition table is a permitted module constant).
export const hostEnv = new EnvRegistry(CLI_ENV_SPECS);

/**
 * Pre-scope variables read raw at their sites (documented `env-via-registry`
 * allowance), declared here so the env-surface reference is complete.
 */
export const PRE_SCOPE_ENV_SPECS: readonly EnvVarSpec<unknown>[] = [
  { canonical: 'NO_COLOR', docs: 'Disable ANSI colours (https://no-color.org). Resolved by the terminal theme.' },
  { canonical: 'FORCE_COLOR', docs: 'Force ANSI colours even when the stream is not a TTY.' },
  { canonical: 'COLORTERM', docs: 'Terminal colour capability hint (e.g. truecolor).' },
  { canonical: 'TERM', docs: 'Terminal type; consulted for colour support.' },
  { canonical: 'TERM_PROGRAM', docs: 'Terminal program (e.g. iTerm.app); consulted for colour support.' },
  { canonical: 'NODE_OPTIONS', docs: 'Node flags; the graph heap-preflight reads/extends this before relaunch (pre-module).' },
];

/**
 * Every environment variable the platform reads, across all layers — the source
 * of truth for the generated env-surface reference (Phase 6).
 */
export function describeHostEnv(): readonly EnvVarSpec<unknown>[] {
  return [...CONFIG_ENV_SPECS, ...GRAPH_ENV_SPECS, ...CLI_ENV_SPECS, ...PRE_SCOPE_ENV_SPECS];
}
