/**
 * host-env-specs — the CLI's environment-variable surface (launch, §5.12).
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
 * Pre-scope exceptions: the terminal-theme color vars (`@opensip-cli/cli-ui` has
 * no `core` dependency and resolves colors before any scope exists) and
 * `NODE_OPTIONS` / `OPENSIP_HEAP_ELEVATED` (the graph heap-preflight reads and
 * mutates them before any opensip module loads) are read raw at their sites.
 * They are declared here for documentation only and allow-listed by the
 * `env-via-registry` guardrail.
 */

import { CONFIG_ENV_SPECS } from '@opensip-cli/config';
import { CORRELATION_ENV_SPECS, EnvRegistry, type EnvVarSpec } from '@opensip-cli/core';

/** CLI-layer infra variables: OpenTelemetry + the update-notifier opt-outs. */
export const CLI_INFRA_ENV_SPECS: readonly EnvVarSpec<unknown>[] = [
  {
    canonical: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    docs: 'OTLP/HTTP endpoint. When set, the CLI enables OpenTelemetry tracing; unset is a hard no-op.',
  },
  {
    canonical: 'OPENSIP_PROFILING',
    docs: 'Explicit gate for the optional CPU profiling path (ADR-0049). "1" or "true" forces on when OTEL_EXPORTER_OTLP_ENDPOINT is set; "0"/"false" forces off. When omitted and the OTLP endpoint is present, falls back to the documented OTEL-only mode (with cost warnings emitted).',
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
    canonical: 'OPENSIP_CLI_SHOW_INTERNAL',
    // Strict `=1` gate (tool-command-surface-taxonomy Tier-3 reveal): only the
    // exact value `'1'` reveals internal commands. The coerce returns a boolean
    // so `hostEnv.get<boolean>('OPENSIP_CLI_SHOW_INTERNAL')` is the single
    // predicate help + completion share (see showInternalCommands).
    coerce: (raw) => raw === '1',
    default: false,
    docs:
      'Set to 1 to reveal Tier-3 internal commands (*-run-worker, *-shard-worker, ' +
      'graph-equivalence-check) in `--help` and shell completion. They stay directly ' +
      'invocable regardless of this flag; it only un-hides them from the public surface. ' +
      'The agent-catalog (a curated machine surface) is intentionally NOT affected.',
  },
  {
    canonical: 'OPENSIP_CLI_SKIP_BUNDLED',
    coerce: (raw) =>
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    default: [] as readonly string[],
    docs:
      'Comma-separated bundled-tool ids (fitness/simulation/graph) to NOT load as bundled. ' +
      'A skipped tool can instead be loaded from an installed/project-local package of the same id ' +
      '— the install-source-independence escape hatch. Unset = load all bundled tools.',
  },
  {
    canonical: 'OPENSIP_CLI_SKIP_INSTALLED',
    coerce: (raw) => raw.length > 0,
    default: false,
    docs:
      'Set to any non-empty value to skip discovery and loading of installed npm tool packages ' +
      '(opensipTools.kind === tool in ancestor node_modules). Bundled and authored tools are ' +
      'unaffected. Equivalent to passing --no-plugins. Use for incident response when ambient ' +
      'plugins must not execute in the host process.',
  },
  {
    canonical: 'OPENSIP_CLI_ALLOW_INSTALLED_TOOLS',
    coerce: (raw) =>
      raw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    default: [] as readonly string[],
    docs:
      'Comma/whitespace-separated installed npm Tool ids to admit (deny-by-default). ' +
      "Use '*' to admit all ambient opensipTools.kind === tool packages discovered in " +
      'ancestor node_modules. Unset = skip installed tools unless explicitly allowlisted. ' +
      'Does not affect bundled or authored tools. Pair with OPENSIP_CLI_SKIP_INSTALLED for ' +
      'incident response (kill switch wins).',
  },
  // ADR-0054 M4-E: `OPENSIP_CLI_EXTERNAL_WORKER` (the opt-in gate for the
  // out-of-process dispatch plane) was RETIRED. External (installed /
  // project-local / user-global) tools now fork the worker BY DEFAULT — the gate
  // is gone, not a no-op. `OPENSIP_CLI_NO_WORKER` is bundled-only (documented on
  // its core spec in subprocess-transport.ts): it never lets an external tool run
  // in-host; an external tool that cannot fork is a hard error.
  {
    canonical: 'OPENSIP_CLI_ALLOW_PROJECT_TOOLS',
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
      '<project>/opensip-cli/tools/ is NOT loaded unless its id (or *) appears here — it ' +
      'rides in with git clone, so loading it runs untrusted code. Global-authored tools ' +
      '(~/.opensip-cli/tools/) are trusted-by-default and ignore this list.',
  },
  {
    canonical: 'OPENSIP_CLI_TOOL_ENV_PASSTHROUGH',
    coerce: (raw) =>
      raw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    default: [] as readonly string[],
    docs:
      'Comma/whitespace-separated extra environment variable names to forward into external-tool ' +
      'dispatch worker children beyond the default allow-list (PATH, HOME, TMPDIR, OTEL_*, etc.). ' +
      'Use when a specific external tool legitimately needs a parent env var (e.g. HTTP_PROXY). ' +
      'Does not affect bundled live-run worker forks.',
  },
];

/**
 * The full CLI env surface = infra vars + the ten subprocess-correlation vars.
 *
 * The canonical names + docs for the ten `OPENSIP_*` correlation vars
 * (`OPENSIP_RUN_ID`, `OPENSIP_TOOL`, `OPENSIP_PARENT_COMMAND`, `OPENSIP_TRACE_ID`,
 * `OPENSIP_SHARD_ID`, `OPENSIP_WORKER_KIND`, `OPENSIP_REPO`, `OPENSIP_REPO_ID`,
 * `OPENSIP_TENANT_ID`, `OPENSIP_CHILD_INVOCATION_ID`) are OWNED by
 * `@opensip-cli/core`'s `run-correlation.ts` (`CORRELATION_ENV_SPECS`) — the single
 * source of truth that `correlationFromEnv()` also reads through. The host SURFACES
 * them here (for the env-surface reference doc + governance) by SPREADING the core
 * table; it never re-declares them. The `...CORRELATION_ENV_SPECS` spread — not this
 * comment — is what keeps the codec and the governed env surface in lockstep.
 *
 * `OPENSIP_API_KEY` is deliberately NOT part of this set — it lives in
 * `CONFIG_ENV_SPECS` (`global-config.ts`) and must never be conflated with
 * correlation.
 */
export const CLI_ENV_SPECS: readonly EnvVarSpec<unknown>[] = [
  ...CLI_INFRA_ENV_SPECS,
  ...CORRELATION_ENV_SPECS,
];

/** The composed CLI-layer registry. Telemetry + update-notifier read through it. */
// @allow-module-singleton EnvRegistry is IMMUTABLE — a constant spec table + on-demand process.env reads; it holds no per-run mutable state, so it is not the scope-isolation hazard no-module-singleton targets (spec §5.12 resolved decision: the env definition table is a permitted module constant).
export const hostEnv = new EnvRegistry(CLI_ENV_SPECS);

/**
 * Env vars a BUNDLED TOOL reads through its own `EnvRegistry`, documented here
 * at the composition root for the env-surface reference.
 *
 * The host does not statically import tool packages just to read env specs
 * (e.g. `GRAPH_ENV_SPECS` from `@opensip-cli/graph`) — that would couple the
 * host to a tool runtime and break the install-source-independence the
 * `no-bootstrap-tool-import` guardrail enforces. The tool keeps OWNING the
 * runtime read (its registry, its coercion); the composition root names the
 * variable for documentation only, the same way it already documents the
 * graph-related `NODE_OPTIONS` below. The `host-env-specs` drift test asserts
 * this list stays a superset of each bundled tool's actual specs (e.g. graph's
 * `GRAPH_ENV_SPECS`), so a tool adding an env var fails CI until it is
 * documented here.
 */
export const BUNDLED_TOOL_ENV_SPECS: readonly EnvVarSpec<unknown>[] = [
  {
    canonical: 'OPENSIP_HEAP_NO_MONITOR',
    docs: 'Set to 1 to disable the graph V8 heap-pressure monitor (REPL embedding / custom allocators).',
  },
  {
    canonical: 'GRAPH_EQUIV_DIAG',
    docs:
      'File path. When set, the graph `graph-equivalence-check` writes a structured JSON ' +
      'diagnostic of every production decline/phantom divergence (owner, resolved targets, ' +
      'and the call edge on both engines) to that path. Diagnostic-only; unset in normal runs.',
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
  {
    canonical: 'OPENSIP_HEAP_ELEVATED',
    docs: 'Internal graph heap-preflight sentinel set on the relaunched child process to prevent recursive relaunch.',
  },
];

/**
 * Every environment variable the platform reads, across all layers — the source
 * of truth for the generated env-surface reference (Phase 6).
 */
export function describeHostEnv(): readonly EnvVarSpec<unknown>[] {
  return [
    ...CONFIG_ENV_SPECS,
    ...BUNDLED_TOOL_ENV_SPECS,
    ...CLI_ENV_SPECS,
    ...PRE_SCOPE_ENV_SPECS,
  ];
}
