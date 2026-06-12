---
status: current
last_verified: 2026-06-08
release: v1.0.0
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

## Observability (OpenTelemetry)

| Variable | Effect |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP endpoint. When set, the CLI enables OpenTelemetry tracing; unset is a hard no-op (standalone runs pay nothing). |
| `TRACEPARENT` | W3C traceparent of a parent trace (read only when telemetry is on); run spans nest under it. |

## Update notifier

| Variable | Effect |
|---|---|
| `OPENSIP_NO_UPDATE` | Set to any non-empty value to skip the CLI update check. |
| `NO_UPDATE_NOTIFIER` | npm-convention update-notifier opt-out; honoured as an equivalent of `OPENSIP_NO_UPDATE`. |
| `OPENSIP_CLI_SKIP_BUNDLED` | Comma-separated bundled-tool ids (`fitness`/`simulation`/`graph`) to NOT load as bundled, so an installed or project-local package of the same id can take over instead. Unset loads all bundled tools. |

## Authored tools

| Variable | Effect |
|---|---|
| `OPENSIP_CLI_ALLOW_PROJECT_TOOLS` | Comma/whitespace-separated project-authored Tool ids to admit (deny-by-default); `*` admits all. A project-authored sidecar Tool under `<project>/opensip-cli/tools/` is NOT loaded unless its id (or `*`) appears here — it rides in with `git clone`, so loading it runs untrusted code (fail-closed, exit 5, before any import). Global-authored Tools under `~/.opensip-cli/tools/` are trusted-by-default and ignore this list. |

## Graph engine

| Variable | Effect |
|---|---|
| `OPENSIP_HEAP_NO_MONITOR` | Set to `1` to disable the V8 heap-pressure monitor (REPL embedding / custom allocators). |

## Execution

| Variable | Effect |
|---|---|
| `OPENSIP_CLI_NO_WORKER` | Set to `1` to run a tool's engine in the main process instead of a forked off-process worker ([ADR-0028](../../decisions/ADR-0028-off-main-thread-execution.md)). Interactive (TTY) runs normally fork a headless worker so the live spinner + clock never stall under a synchronous CPU blast; this forces the in-process path (debugging / constrained runtimes). The live view may stutter; machine output and exit codes are unchanged. |

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
