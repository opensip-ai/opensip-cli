# Subprocess correlation: the 2am operator playbook

You are on call. A sharded `graph` build (or a live-engine `fit`/`sim`/`graph`
run) failed, and all you have is the JSONL logs. This is how you attribute the
failure to a single shard/worker **from logs alone** — no OTel collector, no
cloud, no extra infra required (ADR-0004: OTel is opt-in). When OTel *is* on,
the same lines carry a `traceId` you can pivot on.

Every parent CLI process and every child it spawns/forks share one
`RunCorrelation` bag (`runId`, `tool`, `parentCommand`, `traceId`, `repo`,
`shardId`, `workerKind`, …). The parent forwards it to children via
`OPENSIP_*` env (`runId` travels as `OPENSIP_RUN_ID`) and a JSON-safe
`correlation` object on the shard spec. So one filter key — `runId` — pulls the
parent run **and** all of its child lines out of the log together. That single-
query attribution is the whole point of this machinery.

## Where the logs live

Daily-rotated JSONL, one object per line, under the project's gitignored
runtime dir:

```
<project>/opensip-cli/.runtime/logs/<YYYY-MM-DD>.jsonl
```

Each line is **flat** (structured fields are merged onto the top-level object,
not nested under `data`), so jq filters read fields directly: `.runId`, `.evt`,
`.shardId`, `.traceId`, `.failureClass`, `.exitCode`, `.stderrPreview`, plus
`.ts` and `.level`.

## Step 1 — Get the `runId`

Three sources, in order of convenience:

- **`--json` output** — `outcome.diagnostics.runId`. If you can re-run or the
  user captured it: `opensip graph … --json | jq -r '.diagnostics.runId'`.
- **The log file** — every line for the run carries the same `.runId`; if you
  know roughly when it happened, grab any line near that timestamp.
- **A support ticket** — the operator pasted it.

```bash
# Confirm the runId exists in today's log
jq -r 'select(.runId) | .runId' opensip-cli/.runtime/logs/*.jsonl | sort -u
```

## Step 2 — Filter all lines for the run

One query → every parent + child line for the failed run:

```bash
jq 'select(.runId == "run_…")' opensip-cli/.runtime/logs/*.jsonl
```

This is the single-query attribution success criterion: parent
`graph.shard.runner.*` lines and child `graph.shard.worker.*` /
`cli.subprocess.*` lines all share the one `runId`, because the parent forwarded
`OPENSIP_RUN_ID` into the child env and the pre-action hook reads it **first**
(falling back to a fresh id only when absent).

## Step 3 — Narrow to shard attribution

Pipe Step 2 into an `evt` prefix filter:

```bash
jq 'select(.runId == "run_…")' opensip-cli/.runtime/logs/*.jsonl \
  | jq 'select(.evt | startswith("graph.shard."))'
```

For the fork / live-engine path (`fit`/`sim`/`graph` live runners) use the
`cli.subprocess.` prefix instead:

```bash
… | jq 'select(.evt | startswith("cli.subprocess."))'
```

Read these fields off the matching lines:

- `shardId` — which shard failed.
- `exitCode` — the child's exit code.
- `failureClass` — the machine-filterable failure taxonomy:
  - `spawn` — the child process never started (bad binary/argv/permissions).
  - `exit_nonzero` — the child ran and exited non-zero (a real shard build error).
  - `stdout_parse` — the child exited 0 but its stdout fragment was unparseable
    (IPC/serialization mismatch — suspect a partial parent↔worker build skew).
  - `timeout` — the hard kill-timeout fired (see Step 4).
  - `ipc_error` — the fork IPC channel errored.
- `stderrPreview` — a capped (~500 char) **structured-log** preview of the
  child's stderr. The full, untruncated stderr is in the parent's user-facing
  `ShardFailure.stderr` / merge output — `stderrPreview` is the log-line copy so
  you can triage without the full blob.

The parent's `graph.shard.runner.shard_failed` carries
`{ shardId, exitCode, failureClass, stderrPreview }`; `graph.shard.runner.complete`
carries `{ built, failed, failedShardIds }`; the merge stage emits
`graph.shard.merge` with `{ fragmentCount, failedShardIds }`. Start at
`runner.complete` for the `failedShardIds` list, then read the matching
`shard_failed` line(s).

```bash
# Just the failed-shard summary + per-shard failures
jq 'select(.runId == "run_…") | select(.evt | test("runner\\.(shard_failed|complete)$"))' \
  opensip-cli/.runtime/logs/*.jsonl
```

## Step 4 — Hung shard (`failureClass: "timeout"`)

A `graph.shard.runner.shard_failed` line with `failureClass: "timeout"` means
the shard **did not crash — it hung**, and the hard wall-clock kill-timeout
SIGKILLed it so the pool could settle instead of stalling forever. The timeout
is a fixed conservative constant, `SHARD_HARD_KILL_TIMEOUT_MS` (currently 10
minutes) in `packages/graph/engine/src/cli/orchestrate/shard-runner.ts`. It is
**not yet user-tunable** — a configurable retry/backoff policy is deferred to a
separate resilience spec. If you see `timeout`, the shard is genuinely wedged
(infinite loop, deadlock, blocked I/O); re-running rarely helps. Capture the
shard's inputs and escalate to the owning team.

## Step 5 — Pivot to the trace (when OTel is on)

Every shard/worker event carries `traceId` whenever OTel is enabled
(`OTEL_EXPORTER_OTLP_ENDPOINT` set). Two pivots:

- **Log line → trace.** Take `.traceId` off any matching JSONL line and open it
  in your trace UI.
- **`--json` → trace.** `outcome.diagnostics.trace.traceId` (and `.spanId`) when
  telemetry is on; `outcome.diagnostics.events` holds the same subprocess
  milestones, filterable by `data.shardId`.

```bash
jq -r 'select(.runId == "run_…") | .traceId' opensip-cli/.runtime/logs/*.jsonl \
  | grep -v '^null$' | sort -u
```

State plainly: **correlation works on logs ALONE when OTel is off.** `traceId`
is `null`/omitted in that case — the `runId` + `shardId` filter above is already
sufficient to attribute the failure. The trace is a convenience pivot, never a
dependency.

## Step 6 — Missing correlation (a wiring bug, not a normal state)

A `cli.subprocess.correlation_missing` **warn** line means a worker started with
no correlation env — so `correlationFromEnv()` returned `undefined` and the
child proceeded on a freshly minted `runId` (it does not crash). This is
observable on purpose: a silent fresh-`runId` fallback would defeat
single-query attribution. Treat it as a **wiring bug** — a spawn/fork site that
failed to forward `correlationToEnv(c)` — not a normal state. The child's lines
won't join the parent's `runId`; find the new `runId` on the
`correlation_missing` line to follow that orphaned child.

```bash
jq 'select(.evt == "cli.subprocess.correlation_missing")' opensip-cli/.runtime/logs/*.jsonl
```

## Step 7 — Cloud escalation

If you escalate to OpenSIP Cloud, the join key the CLI sent is the **free-form
`repo`** string (the cwd / `owner/repo` the CLI resolved, attached only when
cloud egress was active for the run). Server-side, Cloud resolves that `repo`
to a `tenant.repos.id` surrogate — **the CLI does not hold a canonical
`repoId`**, so don't expect one on the log line. Likewise `tenantId` is
**derived server-side from the API key**, not sent on the CLI line. In OTel,
`repo` is emitted under the span attribute `opensip.repo_key` and the tenant
under `opensip.tenant_id` (`REPO_OTEL_ATTR` / `TENANT_OTEL_ATTR` in
`packages/core/src/lib/run-correlation.ts`).

The API key itself is **never** in the correlation bag or any child env — it
flows through its own `OPENSIP_API_KEY` path. Never look for (or paste) a secret
from these log lines; there isn't one.

```bash
# The cloud join key the CLI forwarded for this run (present only when cloud was active)
jq -r 'select(.runId == "run_…") | .repo // empty' opensip-cli/.runtime/logs/*.jsonl | sort -u
```

## Event reference

Authoritative names and required fields live in the spec's normative Event
Catalog (`docs/plans/specs/subprocess-correlation-telemetry.md`, local-only).
The events this playbook filters on:

| `evt` | Emitter | Key fields |
|-------|---------|------------|
| `graph.shard.runner.start` | parent | `runId`, `traceId`, `tool`, `parentCommand`, `shards`, `concurrency`; `repo` when cloud active |
| `graph.shard.runner.shard_failed` | parent | `shardId`, `exitCode`, `failureClass`, `stderrPreview` |
| `graph.shard.runner.complete` | parent | `built`, `failed`, `failedShardIds` |
| `graph.shard.worker.start` | child | full correlation + `shardId` |
| `graph.shard.worker.complete` | child | full correlation + `durationMs` |
| `graph.shard.worker.error` | child | full correlation + `err`, `failureClass` |
| `graph.shard.merge` | parent | `runId`, `traceId`, `fragmentCount`, `failedShardIds` |
| `cli.subprocess.spawn` | parent | `runId`, `traceId`, `workerKind`, `command` |
| `cli.subprocess.failed` | parent | `runId`, `traceId`, `workerKind`, `failureClass` |
| `cli.subprocess.correlation_missing` | child | `runId` (freshly minted), `workerKind`, `reason` (warn) |

## TL;DR — the one-liner

```bash
jq 'select(.runId == "run_…")' opensip-cli/.runtime/logs/*.jsonl \
  | jq 'select(.evt | startswith("graph.shard."))'
```

`runId` pulls the whole run (parent + children); the `evt` prefix narrows to
shard attribution; read `shardId` + `failureClass` + `stderrPreview`; pivot to
`traceId` only if you want the trace.
