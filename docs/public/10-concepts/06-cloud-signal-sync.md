---
status: current
last_verified: 2026-06-04
release: v2.6.x
title: "Cloud signal sync"
audience: [getting-started, ci-integrators, contributors]
purpose: "How OpenSIP Cloud signal sync works end to end — the pipeline, exactly what is sent, the entitlement and best-effort guarantees, and the three ways to turn it off."
source-files:
  - packages/core/src/types/signal.ts
  - packages/core/src/types/signal-batch.ts
  - packages/core/src/signals/signal-sink.ts
  - packages/reporting/src/resolve-signal-sink.ts
  - packages/reporting/src/emit-run-signals.ts
  - packages/reporting/src/entitlement.ts
  - packages/reporting/src/cloud-signal-sink.ts
  - packages/reporting/src/http-egress.ts
related-docs:
  - ../70-reference/01-cli-commands.md
  - ../70-reference/03-configuration.md
  - ../decisions/ADR-0008-opensip-cloud-signal-sync.md
---
# Cloud signal sync

Cloud signal sync is an **optional, entitlement-gated, best-effort** sidecar to a normal run. When you have an OpenSIP Cloud API key and the cloud-storage entitlement, each `fit`/`graph` run *also* sends the findings it already computes to OpenSIP Cloud, where they're stored for you. It is **additive**: your results are always written to the local SQLite store first, and a cloud failure never blocks, slows, or fails a run. Decided in [ADR-0008](../decisions/ADR-0008-opensip-cloud-signal-sync.md).

If you don't have a key, none of this runs — no network, no check, no cost. The keyless OSS majority can ignore this page.

> **What you'll understand after this:**
> - The pipeline from a run to the cloud, and where each step lives.
> - Exactly what is sent (the `SignalBatch` payload).
> - Why it can never break a run (best-effort + fail-closed entitlement).
> - The three independent ways to turn it off.

---

## The pipeline

```
 a run produces Signals (the findings it already computes)
            │
            ▼
   emitRunSignals(output)            packages/reporting/src/emit-run-signals.ts
            │  builds a SignalBatch (signals + repo identity + run metadata)
            ▼
   the selected SignalSink           chosen once at startup (see below)
            │
     ┌──────┴───────────────┐
     │                      │
 noopSignalSink        cloud sink            packages/reporting/src/cloud-signal-sink.ts
 (keyless / opted out)  │  checkEntitlement (cached, fail-closed)
   does nothing         │  └─ not entitled → stop, nothing sent
                        ▼
                 chunk + POST           packages/reporting/src/http-egress.ts
                 (retry, idempotency keys, overall deadline)
                        ▼
                 OpenSIP Cloud (https://opensip.ai/api)
```

**The sink is chosen once, at startup.** The CLI's pre-action hook calls [`resolveSignalSink`](../../../packages/reporting/src/resolve-signal-sink.ts), which returns the **no-op sink** unless *all* of these hold: an API key is present, `cloud.sync` is not `false`, `--no-cloud` was not passed, and the endpoint is HTTPS. So for a keyless run the sink is a no-op with zero IO — the cost only exists when you've opted in.

**The entitlement check is deferred to the first emit, and cached.** [`checkEntitlement`](../../../packages/reporting/src/entitlement.ts) answers "is this key entitled to store signals?" It is **fail-closed**: on *any* ambiguity — no key, an unreachable endpoint, a non-2xx response, a malformed body — the answer is `entitled: false` and nothing is sent. A positive result is cached (~6h) so it isn't a network round-trip every run; a `401`/`403` at emit time busts the cache, so a revoked plan stops within one run rather than waiting out the TTL.

On a successful sync you'll see one line on stderr: `✓ Sent N signals to OpenSIP Cloud`.

---

## Exactly what is sent

The unit of egress is a **`SignalBatch`** ([`packages/core/src/types/signal-batch.ts`](../../../packages/core/src/types/signal-batch.ts)):

```ts
interface SignalBatch {
  schemaVersion: 1;
  tool: string;                 // 'fit' | 'graph'
  recipe?: string;              // the recipe name, if any
  repo: RepoIdentity;           // { id?, remoteUrl?, commit? } — git HEAD sha + origin remote
  runId: string;
  createdAt: string;
  counts: { total: number; bySeverity: Record<string, number> };
  truncated?: { dropped: number };
  signals: Signal[];            // the findings (see below)
}
```

Each `Signal` is a finding the tool **already produced locally** — its file path, message, suggestion, code-location hints, and rule metadata ([`packages/core/src/types/signal.ts`](../../../packages/core/src/types/signal.ts)). The batch adds run context: the tool, recipe, a **repo identity** (your git commit SHA and origin remote URL), a run id, a timestamp, and severity counts. Large batches are capped, with a `truncated` count recording how many were dropped.

Nothing else leaves your machine — no source file contents beyond the path/line/hint already in a finding, no environment, no credentials. The local SQLite store is unaffected and remains the source of truth.

---

## How to turn it off

Three independent controls; a `sync: false` in **either** config wins, and `--no-cloud` overrides everything:

| Scope | How | Effect |
|---|---|---|
| **This run** | `--no-cloud` | Disables sync for the single invocation. |
| **This machine** | `~/.opensip-tools/config.yml` → `cloud.sync: false` | Disables sync for every project run from this account. |
| **This project** | `opensip-tools.config.yml` → `cli.cloud.sync: false` | Disables sync for everyone running this project. |

```yaml
# ~/.opensip-tools/config.yml  (machine-wide, flat keys)
apiKey: '<your-key>'
cloud:
  sync: false          # opt out of cloud signal sync everywhere on this account
  endpoint: https://... # optional https override of the built-in cloud URL
```

See [`70-reference/03-configuration.md`](../70-reference/03-configuration.md) for the config shape and [`70-reference/01-cli-commands.md`](../70-reference/01-cli-commands.md#opensip-cloud-signal-sync) for the flag.

This is distinct from `fit --report-to <url>`, which explicitly POSTs **SARIF** to **any** receiver (and can fail a CI build via exit 4). Cloud sync emits **native signals** to **OpenSIP Cloud** automatically and best-effort.

---

## By tool and mode

Sync only happens on the human-facing modes that produce signals:

- **`fit`** — emits after a run completes.
- **`graph`** — emits on the default render and in `--gate-save`/`--gate-compare`, `--report-to`, and `--catalog-output` modes. It does **not** emit for plain `--json` (a machine-artifact stream, and the carrier each `--workspace` child runs under) or for `--workspace` itself (the parent aggregates per-unit findings for the dashboard, not signals). Run a whole-project `graph` to sync.

---

## Where the code lives

| Concern | File |
|---|---|
| `Signal` shape | `packages/core/src/types/signal.ts` |
| `SignalBatch` envelope + builder | `packages/core/src/types/signal-batch.ts` |
| The `SignalSink` seam (no-op default) | `packages/core/src/signals/signal-sink.ts` |
| Per-run egress entry point | `packages/reporting/src/emit-run-signals.ts` |
| Sink selection (opt-out logic) | `packages/reporting/src/resolve-signal-sink.ts` |
| Entitlement check (cached, fail-closed) | `packages/reporting/src/entitlement.ts` |
| The cloud sink | `packages/reporting/src/cloud-signal-sink.ts` |
| Chunked POST transport (retry, idempotency) | `packages/reporting/src/http-egress.ts` |

The seam lives in `core` (a no-op `SignalSink` by default); the real cloud implementation lives in `@opensip-tools/reporting`, so a tool emits signals without depending on the HTTP/cloud machinery — the CLI wires the real sink in at the composition root.
