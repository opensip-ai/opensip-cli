---
status: active
last_verified: 2026-06-03
owner: opensip-tools
---

# ADR-0008: OpenSIP Cloud signal sync (store-only onboarding tier)

```yaml
id: ADR-0008
title: OpenSIP Cloud signal sync (store-only onboarding tier)
date: 2026-06-03
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: [ADR-0004, ADR-0006]   # opt-in OTel (observability reuse); derived-data persistence policy
tags: [cloud, signals, egress, persistence, telemetry]
enforcement: not-mechanizable
enforcement-reason: >
  The load-bearing invariants (local-always, best-effort/non-blocking,
  fail-closed entitlement, https-only egress, idempotent at-least-once
  delivery) are guarded by unit/integration tests in @opensip-tools/reporting
  and opensip-tools (Phase 6/7 of the signal-sync plan), not by a single
  fitness check. The decoupling boundary (core owns the SignalSink interface;
  reporting owns the cloud impl; no core -> reporting edge) IS mechanized by
  dependency-cruiser.
```

**Decision:** opensip-tools gains an optional, entitlement-gated capability to
emit the `Signal`s it already produces (`packages/core/src/types/signal.ts`,
already "compatible with OpenSIP's signal format") to OpenSIP Cloud as an
additive, best-effort sink. Local SQLite remains the source of truth and is
written on every run; the cloud sink is downstream, never blocks or fails a
run, and is selected only when an API key resolves and a cached entitlement
check is positive. This is a cheap "store your signals" onboarding tier that
upsells to the full OpenSIP plan (which *processes* the same signals); the
store-vs-process distinction is entirely server-side and absent from this
codebase. The signal-ingestion endpoint, entitlement API, and Postgres storage
live in the parent `opensip` repo and do not yet exist — this repo owns the
client and the wire contract (a `SignalBatch` envelope) only.

**Alternatives:**

- *Customer points opensip-tools at their own Postgres as the operational
  store.* Rejected: makes Postgres an operational datastore swap, which forces
  (a) an async flip of the synchronous `DataStore` contract
  (`packages/datastore/src/data-store.ts`) across ~20 consumers, (b) a
  dual-dialect schema + conformance test + a second drizzle-kit migration
  history, and (c) client-side Postgres credential storage (keychain/KMS). The
  sink model delivers the same product goal — customer data in Postgres — with
  none of it, because Postgres becomes a server-side detail behind an HTTP POST.
- *Prisma / a single-source multi-dialect ORM.* Moot under the sink model (no
  client-side Postgres); otherwise rejected as a whole-repo migration off the
  Drizzle investment.
- *Reuse SARIF (`reportToCloud`) as the payload format.* Rejected as the
  *format* — signals are the native currency the full OpenSIP plan consumes —
  but its network machinery is extracted and shared (see below).
- *Eliminate `--report-to` now that we auto-sync.* Rejected: `--report-to` is a
  distinct, documented capability — explicit SARIF 2.1.0 to **any** receiver,
  composable with gate modes, owning **exit code 4** so a CI upload failure
  fails the build. Signal-sync is native signals, OpenSIP Cloud only, automatic,
  and best-effort (never affects the exit code). They are complementary; both
  stay. A shared `postChunked` transport carries both without coupling purpose.

**Rationale:** Signals already exist internally (the check framework produces
them; graph works in `Signal[]` for baseline/gate). The parent platform already
ingests opensip-tools output into Postgres via local subprocess spawn
(`docs/internal/consumers/opensip.md`, Mode 2); the cheap tier is the
over-the-network, customer-machine version of that path. Modeling the cloud as
a *sink* rather than an *operational store* keeps the hard database problems
(async, dialects, credentials) server-side — solved once by us — instead of
shipped into every CLI install. Reusing the existing API key
(`resolveApiKey`) means no new auth surface.

**Consequences:**

- The local datastore contract is unchanged (the central win — no async flip).
- New optional egress of signal data. A `Signal` carries `filePath`, `message`,
  `suggestion`, code-location hints, and `metadata` — this leaves the machine
  when synced. The client therefore: shows a one-time first-run notice of what
  is sent, offers `cloud.sync: false` / `--no-cloud` opt-out, and never logs the
  API key or a creds-bearing URL (nor as an OTel span attribute).
- A new decoupling seam: the `SignalSink` interface lives in `core`; the cloud
  implementation and entitlement client live in `reporting` (which already does
  network egress); selection/wiring lives in `cli`. Tools stay cloud-unaware.
- **Resilience & wire-contract posture** the parent endpoint must honor:
  - *At-least-once with idempotency.* Chunks are retried on `429`/`5xx`; each
    carries a stable `Idempotency-Key` (`runId:chunkOrdinal`). The ingestion
    endpoint MUST de-duplicate on it.
  - *Throttle-aware.* The client honors `Retry-After`; the endpoint should emit
    it under load rather than hard-failing.
  - *Best-effort with an overall deadline.* Sync never blocks/fails a run and
    never hangs the CLI past a bounded wall-clock budget.
  - *Bounded payloads.* A max signals-per-batch with logged truncation (no
    silent caps); the local store still holds everything.
  - *https-only egress.* The credential-bearing `X-API-Key` is never sent over
    plaintext; a plain `http://` endpoint is refused.
  - *Entitlement revocation closes within one run.* A `401`/`403` at emit busts
    the entitlement cache, so a lapsed plan stops syncing immediately rather than
    after the cache TTL.
- A new cross-repo contract (`SignalBatch` + the idempotency/`Retry-After`
  obligations) is recorded in `docs/internal/consumers/opensip.md` as Mode 3;
  changing it follows the coordination rule there.
- This feature is not end-to-end usable until the parent `opensip` repo ships
  the ingestion + entitlement endpoints (tracked as a cross-repo follow-up).

> **Open confirmation (design Q2):** "who owns the run envelope" resolved to
> *we define it here*, consistent with the ingestion endpoint not yet existing.
> If the parent platform already defines a signal-grouping/keying envelope, the
> `SignalBatch` shape should be reconciled with it before the wire contract is
> frozen at `schemaVersion: 1`.

**Related specs / ADRs:** Implemented by the plan at
`docs/plans/ready/opensip-cloud-signal-sync/`. Related: ADR-0004 (opt-in
OpenTelemetry — the observability substrate this reuses), ADR-0006
(derived-data persistence policy — signals are derived data; this governs their
egress, not local materialization).
