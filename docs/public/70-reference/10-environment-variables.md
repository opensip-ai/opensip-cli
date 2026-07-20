---
status: current
last_verified: 2026-07-13
release: v0.8.1
title: "Environment variables"
audience: [ci-integrators, operators]
purpose: "Every environment variable the opensip-cli CLI reads — name, effect, coercion, default. The governed env surface (§5.12)."
source-files:
  - packages/cli/src/env/host-env-specs.ts
  - packages/config/src/document/global-config.ts
  - packages/graph/engine/src/cli/pressure-monitor.ts
  - packages/core/src/runtime/subprocess-transport.ts
related-docs:
  - ./04-json-output-schema.md
  - ../../decisions/ADR-0024-command-outcome-and-observability.md
---
# Environment variables

Every environment variable the CLI reads is declared as an `EnvVarSpec` and read
through a single `EnvRegistry` ([ADR-0024](../../decisions/ADR-0024-command-outcome-and-observability.md)),
so the surface is governed, coerced, and documented. The source of truth is
`describeHostEnv()` in [`packages/cli/src/env/host-env-specs.ts`](../../../packages/cli/src/env/host-env-specs.ts);
the `env-via-registry` fitness check fails CI on any raw `process.env` read that
bypasses the registry.

## Configuration

| Variable | Effect |
|---|---|
| `OPENSIP_API_KEY` | OpenSIP Cloud API key. Overrides the `apiKey` stored in `~/.opensip-cli/config.yml`. |

## Observability and local profiling

| Variable | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP endpoint. When set, the CLI enables OpenTelemetry tracing; unset is a hard no-op (standalone runs pay nothing). |
| `OPENSIP_PROFILING` | Explicit gate for local CPU-profile artifacts ([ADR-0163](../../decisions/ADR-0163-local-cpu-profiling-independent-of-otel-export.md)). `1` or `true` enables profiling without requiring an OTLP endpoint; unset, `0`, and `false` are off. An OTLP endpoint alone never creates profile artifacts. |
| `OPENSIP_PROFILE_DIR` | Optional caller-selected directory for local `.cpuprofile` and `.labels.json` artifacts. Relative paths resolve from the CLI process working directory; files are created exclusively with owner-only permissions. |
| `TRACEPARENT` | W3C traceparent of a parent trace (read only when telemetry is on); run spans nest under it. |

## Update notifier

Product update I/O (not telemetry — see
[ADR-0073](../../decisions/ADR-0073-update-notification-policy.md) and
[ADR-0070](../../decisions/ADR-0070-telemetry-and-outbound-network-posture.md)).
Default-on for interactive TTY; hourly npm version fetch; update-state stores only
`{ latest }`.

| Variable | Effect |
|---|---|
| `OPENSIP_NO_UPDATE` | Set to any non-empty value to skip the CLI update check. |
| `NO_UPDATE_NOTIFIER` | npm-convention update-notifier opt-out; honoured as an equivalent of `OPENSIP_NO_UPDATE`. |
| `OPENSIP_CLI_SKIP_BUNDLED` | Comma-separated bundled-tool ids (`fitness`/`simulation`/`graph`/`yagni`) to NOT load as bundled, so an installed or project-local package of the same id can take over instead. Unset loads all bundled tools. |
| `OPENSIP_CLI_SKIP_INSTALLED` | Set to any non-empty value to skip discovery and loading of installed npm tool packages (`opensipTools.kind === tool` in ancestor `node_modules`). Bundled and authored tools are unaffected. Equivalent to passing `--no-plugins`. Use for incident response when ambient plugins must not execute in the host process. |
| `OPENSIP_CLI_ALLOW_INSTALLED_TOOLS` | Override for comma/whitespace-separated exact installed npm Tool ids. `*` is ignored with one bounded warning and admits nothing. Normal `opensip tools install` writes managed trust state, so this is mainly for ambient `node_modules` packages, manual experiments, or incident response. Pair with `OPENSIP_CLI_SKIP_INSTALLED` for incident response (kill switch wins). |

There is no env override for **capability packs** (fit packs, scenario packs,
graph adapters). The former `OPENSIP_CLI_ALLOW_CAPABILITY_PACKS` variable was
removed: repo-committed workflow files and direnv can set env for a direct
`opensip` invocation, so an env allowlist re-opened the analyzed-repo trust
inversion. The single capability-pack trust surface is the user-level
global-config trust list written by `opensip policy trust <pack>`
([ADR-0171](../../decisions/ADR-0171-capability-pack-admission-trusts-operator-config.md)).

## Authored tools

| Variable | Effect |
|---|---|
| `OPENSIP_CLI_ALLOW_PROJECT_TOOLS` | Override for comma/whitespace-separated exact project-authored Tool ids. `*` is ignored with one bounded warning and admits nothing. The normal committed trust path is `tools.trusted` in `opensip-cli.config.yml`. A project-authored sidecar Tool under `<project>/opensip-cli/tools/` is NOT loaded unless its id appears in config or this override — it rides in with `git clone`, so loading it runs untrusted code (fail-closed, exit 5, before any import). Global-authored Tools under `~/.opensip-cli/tools/` are trusted-by-default and ignore this list. |

## Command surface

| Variable | Effect |
|---|---|
| `OPENSIP_CLI_SHOW_INTERNAL` | Set to `1` to reveal internal (Tier-3) commands — the IPC/CI workers `fit-run-worker`, `sim-run-worker`, `graph-run-worker`, `graph-shard-worker`, and the CI gate `graph-equivalence-check` — in `opensip --help` and shell completion. These commands stay directly invocable regardless of this flag; it only un-hides them from those public surfaces. The `agent-catalog` (a curated machine surface) is intentionally NOT affected. |

## MCP server

| Variable | Effect |
|---|---|
| `OPENSIP_MCP_ALLOW_MUTATIONS` | Set to `1` to enable explicitly mutating MCP tools such as `repair_apply_verify` when serving over stdio. Equivalent to `opensip mcp --allow-mutations`. |

## Graph engine

| Variable | Effect |
|---|---|
| `OPENSIP_HEAP_NO_MONITOR` | Set to `1` to disable the V8 heap-pressure monitor (REPL embedding / custom allocators). |
| `GRAPH_EQUIV_DIAG` | File path. When set, the graph `graph-equivalence-check` writes a structured JSON diagnostic of every production decline/phantom divergence (owner, resolved targets, and the call edge on both engines) to that path. Diagnostic-only; unset in normal runs. |
| `OPENSIP_GRAPH_WORKSPACE_CHILD` | Internal sentinel set by `graph --workspace` on each spawned `graph <unit> --json` child so the child's plain `--json` path skips inline signal delivery (no per-unit cloud egress or verdict exit — the parent owns the aggregate). Never set by hand. |

## YAGNI audit

| Variable | Effect |
|---|---|
| `OPENSIP_YAGNI_MIN_CONFIDENCE` | Override `yagni.defaultMinConfidence` (`low`, `medium`, `high`). |
| `OPENSIP_YAGNI_INCLUDE_TESTS` | Override `yagni.includeTests` (`1`/`true` or `0`/`false`). |

## Execution

| Variable | Effect |
|---|---|
| `OPENSIP_CLI_NO_WORKER` | Set to `1` to run a **bundled** tool's engine in the main process instead of a forked off-process worker ([ADR-0028](../../decisions/ADR-0028-off-main-thread-execution.md)). Interactive (TTY) runs normally fork a headless worker so the live spinner + clock never stall under a synchronous CPU blast; this forces the in-process path (debugging / constrained runtimes). The live view may stutter; machine output and exit codes are unchanged. **Bundled-only** ([ADR-0054](../../decisions/ADR-0054-tool-fault-isolation-boundary.md) trust tier): external (installed / project-local / user-global) tool commands always fork the worker — this flag never makes an external tool run in the host process, and an external tool that cannot fork is a hard error. |
| `OPENSIP_CLI_TOOL_ENV_PASSTHROUGH` | Explicit opt-in list of extra env var names to forward into external-tool dispatch workers beyond the default allowlist and manifest-declared env resources. Arbitrary parent secrets are not inherited by default. Admission controls are forwarded so the worker sees the supervisor's exact trust decision. Does not affect bundled live-run worker forks. |

## State write locking

Optional overrides for datastore-file and artifact-file write locks
([ADR-0075](../../decisions/ADR-0075-state-locking-and-baseline-identity-versioning.md)).
Local interactive runs wait longer by default; CI runs fail faster.

| Variable | Default | Effect |
|---|---|---|
| `OPENSIP_STATE_LOCK_WAIT_MS` | `30000` (local), `5000` when `CI` is set | Maximum milliseconds to wait for a write lock before timing out. |
| `OPENSIP_STATE_LOCK_STALE_MS` | `600000` | Treat a lock as stale when the owner process is gone or heartbeat is older than this value (ms). |
| `CI` | (unset) | Standard CI sentinel; when set, selects the shorter default lock wait. |

## Worker resource ceilings

Governed limits for forked workers (external-tool dispatch and bundled live-engine
subprocess transport). See [CLI dispatch](../80-implementation/01-cli-dispatch.md#worker-resource-ceilings-forked-dispatch--live-engine-workers).

| Variable | Default | Effect |
|---|---|---|
| `OPENSIP_CLI_WORKER_TIMEOUT_MS` | `120000` | Per-run wall-clock hard cap (ms); not reset per host-RPC upcall. |
| `OPENSIP_CLI_WORKER_MAX_IPC_BYTES` | `33554432` (32 MiB) | Max serialized IPC payload on worker send and host receive. |
| `OPENSIP_CLI_WORKER_MAX_OLD_SPACE_MB` | `4096` | V8 old-space cap (`--max-old-space-size`) for forked workers. |
| `OPENSIP_CLI_WORKER_MAX_RSS_MB` | `6144` | RSS watchdog ceiling; exceeded → child-tree SIGKILL. |
| `OPENSIP_CLI_WORKER_MAX_CONCURRENT_RPC` | `1` | Max concurrent in-flight host-RPC upcalls (dispatch path). |
| `OPENSIP_CLI_WORKER_MAX_TOTAL_RPC` | `5000` | Max total host-RPC upcalls per dispatch run. |
| `OPENSIP_CLI_WORKER_HEARTBEAT_GRACE_MS` | `60000` | Missed heartbeat grace before `heartbeat_missed` kill. |
| `OPENSIP_CLI_WORKER_IDLE_RPC_MS` | *(unset)* | Optional per-upcall idle timer; off by default. |
| `OPENSIP_CLI_WORKER_MAX_CAPTURED_OUTPUT_BYTES` | `33554432` (32 MiB) | `ResultAccumulator` + captured stderr cap. |
| `OPENSIP_CLI_WORKER_STDERR_INHERIT` | `0` | Set to `1` to inherit child stderr (debugging). Default captures a truncated stderr tail on worker fault. |

## Subprocess correlation

When a tool run spawns child CLI processes (a sharded `graph` run, a forked
live-engine worker), the host forwards a correlation bag so an operator can
attribute a child failure to its parent run from JSONL logs alone. These are set
by the host on the child's environment — you normally never set them by hand. The
canonical names and docs are owned by `@opensip-cli/core`'s `run-correlation.ts`
(`CORRELATION_ENV_SPECS`); the CLI env surface spreads that one table. The API key
(`OPENSIP_API_KEY`) is never part of this set.

| Variable | Effect |
|---|---|
| `OPENSIP_RUN_ID` | Parent run's correlation id, inherited by a spawned/forked child. Read first at the pre-action hook; a child re-uses its parent's run id, a top-level invocation mints fresh. |
| `OPENSIP_TOOL` | Owning tool id of the dispatched command (e.g. `graph`, `fit`), forwarded to child workers for log attribution. |
| `OPENSIP_PARENT_COMMAND` | Top-level command name the run started under (e.g. `graph`, `fit`) — distinguishes a child shard worker from a top-level run. |
| `OPENSIP_TRACE_ID` | OTel trace id for log↔trace pivot, stamped on every subprocess event when telemetry is on. Omitted when OTel is off. |
| `OPENSIP_SHARD_ID` | Shard id of a graph shard worker; lets an operator filter a parent run down to a single failing shard. |
| `OPENSIP_WORKER_KIND` | Subprocess worker kind: `shard`, `live-engine`, or `external-tool`. An unrecognised value coerces to unset. |
| `OPENSIP_REPO` | Free-form cloud repo join key (cwd or `owner/repo`) — forwarded only when cloud egress is active for the parent run. |
| `OPENSIP_REPO_ID` | Optional/best-effort resolved repo surrogate (server-side `tenant.repos.id`). Usually absent; prefer `OPENSIP_REPO`. |
| `OPENSIP_TENANT_ID` | Optional cloud tenant id, forwarded only when locally resolvable. The cloud normally derives tenant from the API key server-side. |
| `OPENSIP_CHILD_INVOCATION_ID` | Optional per-child uniqueness id, minted only where per-child uniqueness is needed. |

## Terminal / pre-scope

These are read before any run scope exists (terminal colour resolution and the
graph heap-preflight relaunch), so they are read directly at their sites and
documented here for completeness.

| Variable | Effect |
|---|---|
| `NO_COLOR` | Disable ANSI colours (https://no-color.org). |
| `FORCE_COLOR` | Force ANSI colours even when the stream is not a TTY. |
| `COLORTERM` | Terminal colour-capability hint (e.g. `truecolor`). |
| `TERM` | Terminal type; consulted for colour support. |
| `TERM_PROGRAM` | Terminal program (e.g. `iTerm.app`); consulted for colour support. |
| `NODE_OPTIONS` | Node flags; the graph heap-preflight reads/extends this before relaunch (pre-module). |
| `OPENSIP_HEAP_ELEVATED` | Internal graph heap-preflight sentinel set on the relaunched child process to prevent recursive relaunch. |
