---
status: active
last_verified: 2026-07-20
owner: opensip-cli
---

# ADR-0175: Bounded JSON-safe diagnostics values and a guaranteed `--json` fallback document

```yaml
id: ADR-0175
title: Bounded JSON-safe diagnostics values and a guaranteed --json fallback document
date: 2026-07-20
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0024, ADR-0060, ADR-0065]
tags: [output, observability, diagnostics, contracts, cli]
enforcement: mechanizable
enforced-by: ['script:json-value.test', 'script:diagnostics-bus.test', 'script:render-outcome.test']
enforcement-reason: >
  Unit tests prove the normalizer on hostile inputs (BigInt, cycles, Error,
  throwing toJSON, depth/size caps), DiagnosticsBus.apply at emit, and
  renderOutcome's guaranteed fallback document when final serialization fails.
```

**Decision:** Every diagnostic `data` bag admitted to `DiagnosticsBus` is
normalized at **emit** into a bounded JSON-safe value tree by one core helper
(`toJsonValue` / `toJsonRecord`). Normalization **keeps** the event and replaces
unserializable fragments with deterministic sentinels (cycles, non-finite
numbers, BigInt, functions/symbols, throwing `toJSON`). Separately, the single
`--json` serialization seam (`renderOutcome`) **must never** leave a machine
consumer with zero stdout: if final `JSON.stringify` of a `CommandOutcome` still
throws, it writes a minimal, always-serializable error outcome first, then
surfaces the failure so the host exit plane can mark the run non-success.

**Alternatives:**

- *Normalize only at `renderOutcome` / `JSON.stringify` replacer.* Rejected as the
  sole boundary: the in-memory bus would still hold hostile graphs, and every
  secondary consumer of `snapshot()` (worker→host `ingest`, tests, future sinks)
  would re-risk the same throw. Emit-time admission is the single owner for
  diagnostic bags.
- *Drop the whole event (or the whole `data` bag) on any unserializable leaf.*
  Rejected: silent loss of lifecycle evidence under the exact conditions an
  operator needs most. Keep-with-sentinel preserves that *something* happened and
  names the unserializable shape.
- *Deep-normalize the entire `CommandOutcome` (envelope/data too) before write.*
  Rejected as the primary path: the inner envelope is ADR-0011 currency and is
  already tool-owned structured data; mutating it at the host would break
  byte-identical replay contracts. The fallback document covers residual
  envelope hostilities without rewriting successful payloads.
- *Rely on the existing `output` package `boundedJson` (SARIF properties).*
  Rejected for this plane: that helper is layer-3, SARIF-tuned (drops rather
  than sentinels), and cannot be imported by core where the bus lives.

**Rationale:** On `main`, `DiagnosticsBus.emit` shallow-pushes caller `data` with
no cycle detection or type normalization, and `renderOutcome` calls unguarded
`JSON.stringify(outcome)`. The output plane catches the throw, logs, and flips a
previously successful `--json` run to `RUNTIME_ERROR` **without writing any
stdout document**. That violates the machine contract in ADR-0024 / ADR-0065: a
`--json` consumer must always receive one outer outcome document. Reproducing
with circular `data`, `BigInt`, or a throwing `toJSON` confirms the throw path.
The dual-layer design matches ownership: core owns diagnostic admission; cli owns
the one stdout serialization seam and its last-line fallback.

**Consequences:**

- New pure helper in `@opensip-cli/core` (`toJsonValue` / `toJsonRecord`) with
  explicit depth, string-length, array-length, and object-key caps; deterministic
  sentinels for non-JSON values; `Error` projected to `{ name, message }`.
- `DiagnosticsBus.emit` (and therefore `event`, `emitSubprocessEvent`, and
  `ingest`) normalizes `data` at admission. Callers may still pass open bags;
  the bus is the authority for JSON safety.
- `renderOutcome` (and `renderRaw`) write a minimal fallback JSON document when
  primary serialization throws, then rethrow so `createOutputPlane` still sets
  `RUNTIME_ERROR` when the primary run had been success.
- Residual envelope-level hostilities remain tool bugs; the fallback guarantees
  observability, not fidelity of the broken payload.
- Related work (OBS-DIAG bootstrap fold, OBS-ADAPTER bus events) inherits a safe
  bus; they do not re-implement JSON policy.

**Related ADRs:** ADR-0024 (CommandOutcome + diagnostics bus), ADR-0060 (CLI
diagnostic boundary / run outcomes), ADR-0065 (public JSON / raw-stream policy),
ADR-0011 (SignalEnvelope inner currency — not rewritten here).
