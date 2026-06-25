---
status: current
last_verified: 2026-06-08
release: v0.1.12
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
through a single `EnvRegistry` ([ADR-0024](https://github.com/opensip-ai/opensip-cli/blob/v0.1.12/docs/decisions/ADR-0024-command-outcome-and-observability.md)),
so the surface is governed, coerced, and documented. The source of truth is
`describeHostEnv()` in [`packages/cli/src/env/host-env-specs.ts`](https://github.com/opensip-ai/opensip-cli/blob/v0.1.12/packages/cli/src/env/host-env-specs.ts);
the `env-via-registry` fitness check fails CI on any raw `process.env` read that
bypasses the registry.

## Configuration

| Variable | Effect |
|---|---|
| `OPENSIP_API_KEY` | OpenSIP Cloud API key. Overrides the `apiKey` stored in `~/.opensip-cli/config.yml`. |

## Observability (OpenTelemetry)

| Variable | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP endpoint. When set, the CLI enables OpenTelemetry tracing; unset is a hard no-op (standalone runs pay nothing). |
| `OPENSIP_PROFILING` | Explicit gate for the optional CPU profiling path (ADR-0049). "1" or "true" forces on when OTEL_EXPORTER_OTLP_ENDPOINT is set; "0"/"false" forces off. When omitted and the OTLP endpoint is present, falls back to the documented OTEL-only mode (with cost warnings emitted). |
| `TRACEPARENT` | W3C traceparent of a parent trace (read only when telemetry is on); run spans nest under it. |

## Update notifier

| Variable | Effect |
|---|---|
| `OPENSIP_NO_UPDATE` | Set to any non-empty value to skip the CLI update check. |
| `NO_UPDATE_NOTIFIER` | npm-convention update-notifier opt-out; honoured as an equivalent of `OPENSIP_NO_UPDATE`. |
| `OPENSIP_CLI_SKIP_BUNDLED` | Comma-separated bundled-tool ids (`fitness`/`simulation`/`graph`/`yagni`) to NOT load as bundled, so an installed or project-local package of the same id can take over instead. Unset loads all bundled tools. |
| `OPENSIP_CLI_SKIP_INSTALLED` | Set to any non-empty value to skip discovery and loading of installed npm tool packages (`opensipTools.kind === tool` in ancestor `node_modules`). Bundled and authored tools are unaffected. Equivalent to passing `--no-plugins`. Use for incident response when ambient plugins must not execute in the host process. |
| `OPENSIP_CLI_ALLOW_INSTALLED_TOOLS` | Comma/whitespace-separated installed npm Tool ids to admit (deny-by-default); `*` admits all. Ambient `opensipTools.kind === tool` packages discovered in ancestor `node_modules` (including `opensip tools install` hosts) are NOT loaded unless their id (or `*`) appears here. Pair with `OPENSIP_CLI_SKIP_INSTALLED` for incident response (kill switch wins). |

## Authored tools

| Variable | Effect |
|---|---|
| `OPENSIP_CLI_ALLOW_PROJECT_TOOLS` | Comma/whitespace-separated project-authored Tool ids to admit (deny-by-default); `*` admits all. A project-authored sidecar Tool under `<project>/opensip-cli/tools/` is NOT loaded unless its id (or `*`) appears here — it rides in with `git clone`, so loading it runs untrusted code (fail-closed, exit 5, before any import). Global-authored Tools under `~/.opensip-cli/tools/` are trusted-by-default and ignore this list. |

## Command surface

| Variable | Effect |
|---|---|
| `OPENSIP_CLI_SHOW_INTERNAL` | Set to `1` to reveal internal (Tier-3) commands — the IPC/CI workers `fit-run-worker`, `sim-run-worker`, `graph-run-worker`, `graph-shard-worker`, and the CI gate `graph-equivalence-check` — in `opensip --help` and shell completion. These commands stay directly invocable regardless of this flag; it only un-hides them from those public surfaces. The `agent-catalog` (a curated machine surface) is intentionally NOT affected. |

## Graph engine

| Variable | Effect |
|---|---|
| `OPENSIP_HEAP_NO_MONITOR` | Set to `1` to disable the V8 heap-pressure monitor (REPL embedding / custom allocators). |
| `GRAPH_EQUIV_DIAG` | File path. When set, the graph `graph-equivalence-check` writes a structured JSON diagnostic of every production decline/phantom divergence (owner, resolved targets, and the call edge on both engines) to that path. Diagnostic-only; unset in normal runs. |

## YAGNI audit

| Variable | Effect |
|---|---|
| `OPENSIP_YAGNI_MIN_CONFIDENCE` | Override `yagni.defaultMinConfidence` (`low`, `medium`, `high`). |
| `OPENSIP_YAGNI_INCLUDE_TESTS` | Override `yagni.includeTests` (`1`/`true` or `0`/`false`). |

## Execution

| Variable | Effect |
|---|---|
| `OPENSIP_CLI_NO_WORKER` | Set to `1` to run a **bundled** tool's engine in the main process instead of a forked off-process worker ([ADR-0028](https://github.com/opensip-ai/opensip-cli/blob/v0.1.12/docs/decisions/ADR-0028-off-main-thread-execution.md)). Interactive (TTY) runs normally fork a headless worker so the live spinner + clock never stall under a synchronous CPU blast; this forces the in-process path (debugging / constrained runtimes). The live view may stutter; machine output and exit codes are unchanged. **Bundled-only** ([ADR-0054](https://github.com/opensip-ai/opensip-cli/blob/v0.1.12/docs/decisions/ADR-0054-tool-fault-isolation-boundary.md) trust tier): external (installed / project-local / user-global) tool commands always fork the worker — this flag never makes an external tool run in the host process, and an external tool that cannot fork is a hard error. |
| `OPENSIP_CLI_TOOL_ENV_PASSTHROUGH` | Comma/whitespace-separated extra env var names to forward into external-tool dispatch worker children beyond the default allow-list. The default allow-list also forwards CLI tool admission controls (`OPENSIP_CLI_ALLOW_*_TOOLS` and `OPENSIP_CLI_SKIP_*`) so the worker sees the same explicit trust decisions as the supervising process. Does not affect bundled live-run worker forks. |

## Worker resource ceilings

Governed limits for forked workers (external-tool dispatch and bundled live-engine
subprocess transport). See [CLI dispatch](/docs/opensip-cli/80-implementation/01-cli-dispatch/#worker-resource-ceilings-forked-dispatch--live-engine-workers).

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
