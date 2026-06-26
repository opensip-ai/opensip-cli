# State, Observability, and Concurrency Inventory

Internal planning artifact for Plan 04 (ADR-0075). Records current state owners,
write paths, observability seams, and lock evidence before/after hardening.

## Datastore-backed state

| Plane | Owner | Write | Read | Transaction | Version metadata | Diagnostics |
|-------|-------|-------|------|-------------|------------------|-------------|
| Sessions | `@opensip-cli/session-store` | `SessionRepo.save`, `purge`, `clearAll`, `clearForTool`, `upsertHostMetrics` | `list`, `get`, `latest`, `count` | `save` uses one tx | payload `__version` (ADR-0050) | `session.save.*`, `session.payload.missing_version` |
| Baseline entries/meta | `@opensip-cli/datastore` `BaselineRepo` | `save`, `clear` | `load`, `exists`, `capturedAt`, `loadMeta` | per-tool replace tx | `baselineFormatVersion`, strategy id/version (ADR-0075) | `datastore.baseline.*`, `state.baseline.identity.*` |
| Tool state | `@opensip-cli/datastore` `ToolStateRepo` | `put`, `delete`, `clear` | `get`, `list` | upsert per key | opaque `__version` in payload (ADR-0050) | `datastore.tool_state.*` |
| Graph catalog | `@opensip-cli/graph` `CatalogRepo` | `replaceAll`, `upsertShardFragment`, `pruneShardFragmentsExcept` | `loadFullCatalog`, `hasAnyCatalog` | single-statement upserts | payload `version: '3.0'` | `graph.catalog.*` |
| Graph shard fragments | `@opensip-cli/graph` `CatalogRepo` | `upsertShardFragment`, `pruneShardFragmentsExcept` | `loadValidShardFragment` | per-row upsert | shard payload embeds cache keys | (catalog events) |
| Schema stamp | `@opensip-cli/datastore` factory | `migrate`, `writeUserVersion` | `readUserVersion` | migrate in open | `PRAGMA user_version` | `datastore.migrate` span |

**Write criticality:** `schema-write` (migrate/user_version); `datastore-write` (rows above);
`datastore-read` (list/get/load/exists); `artifact-write` (SARIF + baseline fingerprint JSON).

## Artifact writes

| Artifact | Owner | Path | Mechanism |
|----------|-------|------|-----------|
| SARIF file export | `packages/cli/src/bootstrap/deliver-envelope.ts` | user `--sarif` / `writeSarif` | `writeArtifactAtomically` + per-target lock |
| Baseline fingerprint JSON | `packages/cli/src/bootstrap/baseline-seams.ts` | `exportBaselineFingerprints` | `writeArtifactAtomically` + per-target lock |

Reads do not acquire artifact locks.

## No explicit lock implementation (pre-Plan-04 evidence)

- SQLite WAL + `busy_timeout = 5000` in `packages/datastore/src/backends/shared.ts`
- No `flock`, lockfile, or mutex in production write paths before ADR-0075

**Post-Plan-04:** `withFileLock` in `@opensip-cli/core`; datastore `.write.lock`; artifact `.artifact.lock`.

## Observability baseline

**Diagnostics phases:** `discover`, `load`, `validate`, `execute`, `render`, `deliver`, `persist`.

State-plane events (phase `persist` unless noted):

- `state.lock.acquire.start|wait|complete|timeout`
- `state.lock.stale.recovered`
- `state.baseline.identity.recorded` (`persist`)
- `state.baseline.identity.mismatch` (`load`)
- `state.artifact.write.complete|error`

**Metrics (existing):** `opensip_cli.commands.started`, `opensip_cli.command.duration_ms` (label `command`).

**Trace propagation:** `TRACEPARENT` via `buildExternalWorkerChildEnv`, `dispatch-fork-core`, graph spans `opensip_cli.graph.<stage>`.

**Dogfood:** `logger-event-name-format` (3+ segment names).

## Implementation references (ADR-0075)

- `packages/core/src/baseline/fingerprint-strategy.ts` — descriptors
- `packages/core/src/lib/file-lock.ts` — lock primitive
- `packages/cli/src/bootstrap/state-lock-policy.ts` — env overrides
- `packages/datastore/migrations/0003_baseline_identity_meta.sql` — baseline meta columns
- `docs/decisions/ADR-0075-state-locking-and-baseline-identity-versioning.md`