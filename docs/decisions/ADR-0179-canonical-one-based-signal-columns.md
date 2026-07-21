---
status: active
last_verified: 2026-07-21
owner: opensip-cli
---

# ADR-0179: Canonical 1-based columns on Signal at construction

```yaml
id: ADR-0179
title: Canonical 1-based columns on Signal at construction
date: 2026-07-21
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0036]
tags: [signals, sarif, fitness, graph, output]
enforcement: mechanizable
enforced-by: ['local:signal-column-one-based', 'script:signal.test', 'script:signal-sarif.test', 'script:create-graph-signal.test']
enforcement-reason: >
  createSignal admits only finite column integers ≥ 1; the local dogfood check
  forbids raw match.index as a column; unit tests pin createSignal, graph
  conversion, and SARIF emit of the 1-based value.
```

**Decision:** Every `Signal.column` / `Signal.code.column` is **1-based** when
present. **`createSignal` is the single owner** of that contract: it records only
finite integer columns ≥ 1 and **omits** missing, non-finite, or `< 1` values
(whole-file / whole-line findings). Emitters convert from their native base
before (or at) construction; SARIF emits the stored 1-based column as
`region.startColumn` without guessing the input base.

**Alternatives:**

- *Keep mixed bases and “fix” at SARIF only (`atLeastOne` / +1 at emit).*
  Rejected: `atLeastOne` only drops values `< 1`. A 0-based column of `5`
  passes through as SARIF `startColumn: 5` (off by one). Downstream JSON,
  sessions, MCP, and the dashboard still see the wrong base.
- *`createSignal` always adds +1 (assume all inputs are 0-based).* Rejected:
  several first-party emitters already pass 1-based values (gitleaks
  `StartColumn`, some TS AST checks with `character + 1`); a blind +1 would
  double-convert.
- *Leave columns optional and undocumented.* Rejected: the product surfaces
  (SARIF, reports, agent repair) need a single character-pointing contract.

**Rationale:** On `main`, graph occurrences and many regex checks feed
**0-based** columns (`match.index`, tree-sitter `startPosition.column`, TS
`character`) into `createSignal`, while other checks and external scanners
already use **1-based** columns. `packages/output/src/format/signal-sarif.ts`
clamps with `atLeastOne`, which **masks** zero but does not correct a non-zero
0-based index — so SARIF points at the wrong character. Construction-time
admission is the only place every tool path shares (`createSignal` /
`createSignalFromViolation` / `createGraphSignal`).

**Consequences:**

- `createSignal` normalizes `code.line` / `code.column` (and the mirrored
  `line` / `column` fields): finite integers ≥ 1 are kept; otherwise omitted.
  Lines follow the same ≥ 1 rule (SARIF / editor convention); this ADR’s
  *base* contract is specifically for **columns**.
- Graph keeps **0-based** columns on catalog occurrences (parser-native).
  `createGraphSignal` is the graph conversion seam: it lifts
  `body.code.column` from 0-based occurrence space to 1-based Signal space
  (`column + 1`) before calling `createSignal`. Joins that resolve a Signal
  back to an occurrence (e.g. MCP `toDeadCodeDto` via `byOccId`) convert
  `Signal.column - 1` for the lookup key.

- Regex / string emitters must pass `match.index + 1` (never raw
  `match.index`) as a Signal/violation column. Dogfood check
  `signal-column-one-based` forbids the raw form in production sources.
- `signal-sarif` still omits invalid coordinates for SARIF 2.1.0 validity, but
  must not be treated as the place that “fixes” column base.
- Host baseline fingerprints that include `column` may shift once for
  previously 0-based graph/regex signals; recapture baselines after upgrade.
- Tests: `createSignal` omits column `0`; a formerly 0-based emitter yields
  SARIF `startColumn` pointing at the correct 1-based character; whole-file
  signals still omit the column.
