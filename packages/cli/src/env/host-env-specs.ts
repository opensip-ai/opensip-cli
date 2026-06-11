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
  {
    canonical: 'OPENSIP_TOOLS_SKIP_BUNDLED',
    coerce: (raw) =>
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    default: [] as readonly string[],
    docs:
      'Comma-separated bundled-tool ids (fitness/simulation/graph) to NOT load as bundled. ' +
      'A skipped tool can instead be loaded from an installed/project-local package of the same id ' +
      '— the install-source-independence escape hatch (3.0.0). Unset = load all bundled tools.',
  },
  {
    canonical: 'OPENSIP_TOOLS_ALLOW_PROJECT_TOOLS',
    // Mirror parseAllowlist's split (whitespace AND comma) so the registry value
    // and tool-trust's set agree exactly — including the `*` token, which passes
    // through as a plain id the trust check tests for.
    coerce: (raw) =>
      raw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    default: [] as readonly string[],
    docs:
      'Comma/whitespace-separated project-authored Tool ids to admit (deny-by-default). ' +
      "Use '*' to admit all project-authored tools. A project-authored sidecar tool under " +
      '<project>/opensip-tools/tools/ is NOT loaded unless its id (or *) appears here — it ' +
      'rides in with git clone, so loading it runs untrusted code. Global-authored tools ' +
      '(~/.opensip-tools/tools/) are trusted-by-default and ignore this list.',
  },
];

/** The composed CLI-layer registry. Telemetry + update-notifier read through it. */
// @allow-module-singleton EnvRegistry is IMMUTABLE — a constant spec table + on-demand process.env reads; it holds no per-run mutable state, so it is not the scope-isolation hazard no-module-singleton targets (spec §5.12 resolved decision: the env definition table is a permitted module constant).
export const hostEnv = new EnvRegistry(CLI_ENV_SPECS);

/**
 * Env vars a BUNDLED TOOL reads through its own `EnvRegistry`, documented here
 * at the composition root for the env-surface reference.
 *
 * 3.0.0 GA: the host no longer statically imports a tool package (e.g.
 * `GRAPH_ENV_SPECS` from `@opensip-tools/graph`) — that would couple the host to
 * a tool runtime and break the install-source-independence the `no-bootstrap-tool-import`
 * guardrail enforces. The tool keeps OWNING the runtime read (its registry, its
 * coercion); the composition root names the variable for documentation only, the
 * same way it already documents the graph-related `NODE_OPTIONS` below. The
 * `host-env-specs` drift test asserts this list stays a superset of each bundled
 * tool's actual specs (e.g. graph's `GRAPH_ENV_SPECS`), so a tool adding an env
 * var fails CI until it is documented here.
 */
export const BUNDLED_TOOL_ENV_SPECS: readonly EnvVarSpec<unknown>[] = [
  {
    canonical: 'OPENSIP_HEAP_NO_MONITOR',
    docs: 'Set to 1 to disable the graph V8 heap-pressure monitor (REPL embedding / custom allocators).',
  },
];

/**
 * Pre-scope variables read raw at their sites (documented `env-via-registry`
 * allowance), declared here so the env-surface reference is complete.
 */
export const PRE_SCOPE_ENV_SPECS: readonly EnvVarSpec<unknown>[] = [
  {
    canonical: 'NO_COLOR',
    docs: 'Disable ANSI colours (https://no-color.org). Resolved by the terminal theme.',
  },
  { canonical: 'FORCE_COLOR', docs: 'Force ANSI colours even when the stream is not a TTY.' },
  { canonical: 'COLORTERM', docs: 'Terminal colour capability hint (e.g. truecolor).' },
  { canonical: 'TERM', docs: 'Terminal type; consulted for colour support.' },
  {
    canonical: 'TERM_PROGRAM',
    docs: 'Terminal program (e.g. iTerm.app); consulted for colour support.',
  },
  {
    canonical: 'NODE_OPTIONS',
    docs: 'Node flags; the graph heap-preflight reads/extends this before relaunch (pre-module).',
  },
];

/**
 * Every environment variable the platform reads, across all layers — the source
 * of truth for the generated env-surface reference (Phase 6).
 */
export function describeHostEnv(): readonly EnvVarSpec<unknown>[] {
  return [...CONFIG_ENV_SPECS, ...BUNDLED_TOOL_ENV_SPECS, ...CLI_ENV_SPECS, ...PRE_SCOPE_ENV_SPECS];
}
