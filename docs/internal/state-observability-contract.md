# State Observability Contract

Bounded vocabulary for state-plane diagnostics and logs (Plan 04 / ADR-0075).
OTel remains opt-in via `OTEL_EXPORTER_OTLP_ENDPOINT`.

## Logger events (3+ segments)

| Event | Phase | When |
|-------|-------|------|
| `state.lock.acquire.start` | `persist` | Lock acquisition begins |
| `state.lock.acquire.wait` | `persist` | Contention wait |
| `state.lock.acquire.complete` | `persist` | Lock acquired and work finished |
| `state.lock.acquire.timeout` | `persist` | Wait budget exceeded |
| `state.lock.stale.recovered` | `persist` | Abandoned lock removed |
| `state.baseline.identity.recorded` | `persist` | Baseline saved with strategy metadata |
| `state.baseline.identity.mismatch` | `load` | Compare/export identity incompatible |
| `state.artifact.write.complete` | `persist` | Atomic artifact write succeeded |
| `state.artifact.write.error` | `persist` | Artifact write failed |

## Optional metrics (bounded labels)

If contention metrics are added:

- `opensip_cli.state_lock.wait_ms` — labels `{ resource: 'datastore' | 'artifact', outcome }`
- `opensip_cli.state_lock.contention_total` — same labels

**Forbidden metric labels:** file paths, session ids, run ids, tool-state keys, fingerprints.

## Environment overrides

Declared in `host-env-specs.ts`:

- `OPENSIP_STATE_LOCK_WAIT_MS` — local default 30000, CI default 5000
- `OPENSIP_STATE_LOCK_STALE_MS` — default 600000
- `CI` — selects shorter default wait

## Telemetry posture

No telemetry by default. Worker `TRACEPARENT` propagation unchanged.