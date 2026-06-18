/**
 * run-correlation — the pure correlation primitive (subprocess-correlation
 * telemetry spec, Type Design).
 *
 * CORE-LAYER, PURE. This module must NOT import `@opensip-cli/config` (or any
 * workspace package above core) — `core-must-be-kernel` in
 * `.config/dependency-cruiser.cjs` forbids it. The cloud-aware ASSEMBLY of a
 * `RunCorrelation` (which needs `resolveEffectiveCloudConfig`) happens only at
 * the bootstrap composition root (`build-per-run-scope.ts`, B2); library code
 * deep in the call tree reads the assembled bag via `currentScope()?.correlation`.
 *
 * The module owns:
 *   - the {@link RunCorrelation} interface (the single source of truth for the
 *     correlation field set);
 *   - the canonical `OPENSIP_*` env names + their one-line docs, as the frozen
 *     {@link CORRELATION_ENV_SPECS} table — the ONE definition table the CLI host
 *     SPREADS into its env surface (host-env-specs.ts) so the codec and the
 *     governed env surface never drift;
 *   - {@link CORRELATION_ENV} (canonical env name → `RunCorrelation` field),
 *     derived from / co-located with the spec table;
 *   - the settled OTel attr constants ({@link REPO_OTEL_ATTR},
 *     {@link TENANT_OTEL_ATTR}) — the single source every span-attr site references;
 *   - a pure {@link correlationToEnv} (the env bag for a subprocess spawn — it
 *     NEVER emits the API key);
 *   - {@link correlationFromEnv} (read at worker bootstrap through a core
 *     {@link EnvRegistry} over {@link CORRELATION_ENV_SPECS} — the one sanctioned
 *     `process.env` seam, so `env-via-registry` is satisfied inside core).
 */

import { EnvRegistry, type EnvVarSpec } from './env-registry.js';

/**
 * The correlation bag shared across a parent CLI process and every child it
 * spawns (graph shard, fork) so an operator can attribute a child failure to its
 * parent run from JSONL logs alone — OTel optional.
 *
 * The field set comes verbatim from the subprocess-correlation spec (Type
 * Design); do not invent fields or rename them.
 */
export interface RunCorrelation {
  /** The parent run's correlation id. Travels via `OPENSIP_RUN_ID` env ONLY (B1). */
  readonly runId: string;
  /** The owning tool id of the dispatched command (e.g. `graph`, `fit`). */
  readonly tool: string;
  /** The top-level command name the run started under (e.g. `graph`, `fit`). */
  readonly parentCommand: string;
  /**
   * Trace id for log↔trace pivot. Derived from the active OTel context
   * (`currentTraceparent()`); present whenever OTel is on. Stamped on every
   * shard/worker event so an operator can jump from a JSONL line to the trace.
   */
  readonly traceId?: string;
  /**
   * Free-form cloud repo join key (cwd or `owner/repo`) — what the CLI actually
   * knows. This is the string the cloud resolves to a `tenant.repos.id`
   * surrogate server-side (Cloud identity grounding). Present when cloud egress
   * is active for the parent run.
   */
  readonly repo?: string;
  /**
   * OPTIONAL / best-effort. The resolved `tenant.repos.id` surrogate is a
   * SERVER-SIDE artifact; the CLI rarely holds it. Present only if a resolved
   * surrogate is locally cached. Usually absent — prefer `repo`.
   */
  readonly repoId?: string;
  /**
   * Cloud tenant identity. The cloud DERIVES this from the API key server-side;
   * the CLI does NOT send it in ingest. Present only when the configured
   * identity makes it locally resolvable. Usually absent.
   */
  readonly tenantId?: string;
  /** The shard id when this is a graph shard worker. */
  readonly shardId?: string;
  /** The kind of subprocess worker this correlation describes. */
  readonly workerKind?: 'shard' | 'live-engine' | 'external-tool';
  /** Optional per-child uniqueness id, minted only where it is needed. */
  readonly childInvocationId?: string;
}

// ─── Canonical env names ──────────────────────────────────────────────
//
// Exported so spawn/fork sites and tests reference the names symbolically
// rather than re-typing the string literals. These are the canonical names
// carried in CORRELATION_ENV_SPECS below.

/** `runId` — travels env-only (B1); read first at the pre-action hook. */
export const OPENSIP_RUN_ID = 'OPENSIP_RUN_ID';
/** The owning tool id of the dispatched command. */
export const OPENSIP_TOOL = 'OPENSIP_TOOL';
/** The top-level command name the run started under. */
export const OPENSIP_PARENT_COMMAND = 'OPENSIP_PARENT_COMMAND';
/** The OTel trace id for log↔trace pivot. */
export const OPENSIP_TRACE_ID = 'OPENSIP_TRACE_ID';
/** The shard id of a graph shard worker. */
export const OPENSIP_SHARD_ID = 'OPENSIP_SHARD_ID';
/** The worker kind (`shard` / `live-engine` / `external-tool`). */
export const OPENSIP_WORKER_KIND = 'OPENSIP_WORKER_KIND';
/** The free-form cloud repo join key (cwd or owner/repo). */
export const OPENSIP_REPO = 'OPENSIP_REPO';
/** The optional/best-effort resolved repo surrogate (usually absent). */
export const OPENSIP_REPO_ID = 'OPENSIP_REPO_ID';
/** The optional cloud tenant id (usually absent). */
export const OPENSIP_TENANT_ID = 'OPENSIP_TENANT_ID';
/** The optional per-child uniqueness id. */
export const OPENSIP_CHILD_INVOCATION_ID = 'OPENSIP_CHILD_INVOCATION_ID';

/**
 * OTel span-attribute name for the free-form repo join key.
 *
 * Q4 RESOLVED (2026-06-17): `repo_key` = human-facing/telemetry label;
 * `repo_id` is reserved for schema/FK/persistence (the server-side
 * `tenant.repos.id` surrogate the CLI does not hold). Every span-attr site in
 * Phases 1–3 references THIS constant — no other file hardcodes the repo attr.
 */
export const REPO_OTEL_ATTR = 'opensip.repo_key';

/** OTel span-attribute name for the cloud tenant id (snake_case per cloud). */
export const TENANT_OTEL_ATTR = 'opensip.tenant_id';

/**
 * The ONE definition table for the ten `OPENSIP_*` correlation env vars:
 * canonical name + a one-line docs string each. This is the single source of
 * truth for BOTH the codec's `EnvRegistry` ({@link correlationFromEnv}) and the
 * CLI host env surface — `host-env-specs.ts` SPREADS this (never re-declares the
 * ten specs), so the governed env surface and the codec stay in lockstep.
 *
 * Frozen so it cannot be mutated at runtime; an immutable definition table is a
 * permitted module constant (it holds no per-run mutable state, exactly like
 * `CONFIG_ENV_SPECS` / the host `CLI_ENV_SPECS`).
 */
export const CORRELATION_ENV_SPECS: readonly EnvVarSpec<unknown>[] = Object.freeze([
  {
    canonical: OPENSIP_RUN_ID,
    docs: "Parent run's correlation id, inherited by a spawned/forked child (B1). Read FIRST at the pre-action hook; the spec JSON never carries runId.",
  },
  {
    canonical: OPENSIP_TOOL,
    docs: 'Owning tool id of the dispatched command (e.g. graph, fit), forwarded to child workers for log attribution.',
  },
  {
    canonical: OPENSIP_PARENT_COMMAND,
    docs: 'Top-level command name the run started under (e.g. graph, fit) — distinguishes a child shard worker from a top-level run.',
  },
  {
    canonical: OPENSIP_TRACE_ID,
    docs: 'OTel trace id for log↔trace pivot, stamped on every subprocess event when telemetry is on. Omitted when OTel is off.',
  },
  {
    canonical: OPENSIP_SHARD_ID,
    docs: 'Shard id of a graph shard worker; lets an operator filter a parent run down to a single failing shard.',
  },
  {
    canonical: OPENSIP_WORKER_KIND,
    docs: "Subprocess worker kind: 'shard', 'live-engine', or 'external-tool'. An unrecognised value coerces to undefined.",
  },
  {
    canonical: OPENSIP_REPO,
    docs: 'Free-form cloud repo join key (cwd or owner/repo) — forwarded only when cloud egress is active for the parent run.',
  },
  {
    canonical: OPENSIP_REPO_ID,
    docs: 'Optional/best-effort resolved repo surrogate (server-side tenant.repos.id). Usually absent; prefer OPENSIP_REPO.',
  },
  {
    canonical: OPENSIP_TENANT_ID,
    docs: 'Optional cloud tenant id, forwarded only when locally resolvable. The cloud normally derives tenant from the API key server-side.',
  },
  {
    canonical: OPENSIP_CHILD_INVOCATION_ID,
    docs: 'Optional per-child uniqueness id, minted only where per-child uniqueness is needed.',
  },
]);

/**
 * Map of canonical env name → the `RunCorrelation` field it carries, derived
 * from {@link CORRELATION_ENV_SPECS}. `OPENSIP_API_KEY` is deliberately ABSENT —
 * the API key is never part of the correlation set (it lives in
 * `CONFIG_ENV_SPECS`). Used by the codec below to round-trip the bag.
 */
export const CORRELATION_ENV = Object.freeze({
  [OPENSIP_RUN_ID]: 'runId',
  [OPENSIP_TOOL]: 'tool',
  [OPENSIP_PARENT_COMMAND]: 'parentCommand',
  [OPENSIP_TRACE_ID]: 'traceId',
  [OPENSIP_SHARD_ID]: 'shardId',
  [OPENSIP_WORKER_KIND]: 'workerKind',
  [OPENSIP_REPO]: 'repo',
  [OPENSIP_REPO_ID]: 'repoId',
  [OPENSIP_TENANT_ID]: 'tenantId',
  [OPENSIP_CHILD_INVOCATION_ID]: 'childInvocationId',
}) satisfies Readonly<Record<string, keyof RunCorrelation>>;

/** The accepted `workerKind` values, for the env→union coercion in the reader. */
const WORKER_KINDS: ReadonlySet<string> = new Set(['shard', 'live-engine', 'external-tool']);

/**
 * Build the env bag for a subprocess spawn. PURE: it reads only the named
 * {@link RunCorrelation} fields — never `process.env`, never anything keyed
 * `OPENSIP_API_KEY`. Present fields are emitted under their canonical
 * `OPENSIP_*` name; undefined fields are OMITTED (no empty sentinels). By
 * construction this function cannot place a secret in the env bag (asserted by
 * the M1 test).
 */
export function correlationToEnv(c: RunCorrelation): Record<string, string> {
  const env: Record<string, string> = {};
  // Defensive: iterate the FIXED canonical→field table only. There is no path
  // that reads `process.env` or an `OPENSIP_API_KEY`-shaped key — the bag is
  // assembled purely from the named RunCorrelation fields.
  for (const [name, field] of Object.entries(CORRELATION_ENV)) {
    const value = c[field];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/**
 * Add an optional `RunCorrelation` field to the reader's result object ONLY when
 * the value is present: returns `{ [key]: value }` for a defined value, else `{}`.
 * Keeps the codec free of negated `!== undefined` spread guards while preserving
 * the "omit absent optionals" contract.
 */
function optional<K extends keyof RunCorrelation>(
  key: K,
  value: RunCorrelation[K] | undefined,
): Partial<Pick<RunCorrelation, K>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Pick<RunCorrelation, K>>);
}

/**
 * Read correlation from env at worker bootstrap, via a core {@link EnvRegistry}
 * over {@link CORRELATION_ENV_SPECS} (the single source-of-truth spec table —
 * not a re-declared literal). `runId` (`OPENSIP_RUN_ID`) is read FIRST and
 * independently (B1) so the logger has it before any spec JSON is parsed.
 *
 * Returns `undefined` when NO correlation env is present at all. Otherwise
 * builds the bag, omitting absent optionals; `workerKind` coerces to the union
 * and falls back to `undefined` on an unrecognised value.
 */
export function correlationFromEnv(): RunCorrelation | undefined {
  const env = new EnvRegistry(CORRELATION_ENV_SPECS);

  // B1: runId is read first and independently of the other fields.
  const runId = env.get<string>(OPENSIP_RUN_ID);
  const tool = env.get<string>(OPENSIP_TOOL);
  const parentCommand = env.get<string>(OPENSIP_PARENT_COMMAND);
  const traceId = env.get<string>(OPENSIP_TRACE_ID);
  const shardId = env.get<string>(OPENSIP_SHARD_ID);
  const workerKindRaw = env.get<string>(OPENSIP_WORKER_KIND);
  const repo = env.get<string>(OPENSIP_REPO);
  const repoId = env.get<string>(OPENSIP_REPO_ID);
  const tenantId = env.get<string>(OPENSIP_TENANT_ID);
  const childInvocationId = env.get<string>(OPENSIP_CHILD_INVOCATION_ID);

  // No correlation env present at all → undefined (the bare-worker contract).
  if (
    runId === undefined &&
    tool === undefined &&
    parentCommand === undefined &&
    traceId === undefined &&
    shardId === undefined &&
    workerKindRaw === undefined &&
    repo === undefined &&
    repoId === undefined &&
    tenantId === undefined &&
    childInvocationId === undefined
  ) {
    return undefined;
  }

  const workerKind =
    workerKindRaw !== undefined && WORKER_KINDS.has(workerKindRaw)
      ? (workerKindRaw as RunCorrelation['workerKind'])
      : undefined;

  return {
    // `runId`/`tool`/`parentCommand` are required on the type; a worker missing
    // them gets the empty string rather than a malformed bag — the
    // missing-correlation degradation (Phase 1/2) is detected by the caller via
    // the falsy field, not by a throw here.
    runId: runId ?? '',
    tool: tool ?? '',
    parentCommand: parentCommand ?? '',
    // Omit absent optionals (no empty sentinels). `optional(...)` returns `{}`
    // for `undefined`, so the spread adds the key only when the value is present.
    ...optional('traceId', traceId),
    ...optional('repo', repo),
    ...optional('repoId', repoId),
    ...optional('tenantId', tenantId),
    ...optional('shardId', shardId),
    ...optional('workerKind', workerKind),
    ...optional('childInvocationId', childInvocationId),
  };
}
