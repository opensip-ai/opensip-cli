---
status: active
last_verified: 2026-07-07
owner: opensip-cli
---

# ADR-0036: Baseline capture + net-new ratchet + baseline export are a host-owned plane

```yaml
id: ADR-0036
title: Baseline capture + net-new ratchet + baseline export are a host-owned plane
date: 2026-06-11
status: active
supersedes: []
superseded_by: null
related: [ADR-0011, ADR-0020, ADR-0035]
tags: [output, datastore, gate, baseline, parity]
enforcement: mechanizable
enforced-by: ['depcruise:output-imports-core-contracts-only']
enforcement-reason: >
  Three guards in the implementing spec's verification matrix: (1) a toy fixture
  tool gets `--gate-save`/`--gate-compare` with zero tool-authored persistence/
  diff/fingerprint code (the "free for plugins" proof); (2) fitness and graph
  save→compare on an unchanged tree yields `added=[] degraded=false` (per-tool
  no-flap, proving each fingerprint strategy is preserved); (3) `graph-baseline-export`
  JSON is byte-identical pre/post (the git-trackable consumer-repo artifact stays
  valid). A dependency-cruiser rule keeps the diff in `output` and the repo in
  `datastore` (kernel `core` carries no persistence).
```

**Decision:** Baseline **capture** (`--gate-save`), the **net-new ratchet**
(`--gate-compare`), and baseline **export** (SARIF + git-trackable JSON
fingerprints) are a **host-owned plane**, not per-tool machinery. The plane is
keyed on a **first-class `Signal.fingerprint`** (today an unused field,
`core/src/types/signal.ts`) that each tool populates at signal-creation time via a
**tool-declared fingerprint strategy** (`(signal) => string`; host ships a
default). One generic table pair — `tool_baseline_entries(tool, fingerprint,
payload, captured_at)` + `tool_baseline_meta(tool, captured_at)` — replaces the
three per-tool tables; one pure `added/resolved/unchanged` diff and four
`ToolCliContext` seams (`saveBaseline` / `compareBaseline` / `exportBaselineSarif`
/ `exportBaselineFingerprints`) replace fitness's and graph's bespoke
gate/baseline/fingerprint/export modules (~500 LOC). A new tool gets a CI ratchet
by declaring **at most a fingerprint strategy** — often nothing.

This **complements ADR-0035**: that ADR made pass/fail a host verdict over
*absolute* error/warning counts (the threshold gate); this ADR owns the
**orthogonal** gate ADR-0035 explicitly deferred — *net-new-since-baseline*. The
two are distinct mechanisms a tool may run together (graph CI does: hard-fail on
errors **and** ratchet on net-new).

**Alternatives:**

- **One global fingerprint algorithm.** Rejected: fitness fingerprints on
  `sha256(filePath, ruleId, message)` (excludes line/col so line-shifts don't
  flap); graph fingerprints on `ruleId|filePath|line|col` (excludes message
  because some rules embed run-varying counts in messages, includes column to
  disambiguate same-line occurrences). The two are **oppositely principled and
  both correct** — a per-tool strategy populating `Signal.fingerprint` is
  mandatory, and the plane treats the fingerprint opaquely.
- **Keep per-tool baseline machinery** (status quo). Rejected: it is the largest
  copy-paste surface in the codebase — two fingerprint algorithms, two SQLite
  table designs, two diff shapes (graph's `resolved` is bare strings; fitness's is
  rich objects), two export commands — and it makes a CI ratchet the single
  hardest thing for a third-party tool to build.
- **Fold the ratchet into ADR-0035's findings verdict.** Rejected — and this is
  precisely the thread ADR-0035 deferred ("graph gate-compare is a distinct,
  baseline-diff predicate … No equivalence is asserted here"). Net-new-since-baseline
  answers a *different* question than absolute counts: a run can have `0 errors`
  (findings-verdict PASS) yet introduce a *new* finding (ratchet FAIL). Conflating
  them loses that signal.
- **Blob-per-tool storage** (fitness's current model — store the whole envelope).
  Rejected: cannot produce graph's per-fingerprint ratchet without re-parsing.
  Per-`(tool, fingerprint)` rows with a `payload` projection give graph's fast
  diff, a full-object `resolved` bucket for both tools, and SARIF re-render.
- **Migrate existing baseline rows.** Rejected: baselines are CI-ephemeral (rebuilt
  each CI run per the Dogfood Gate; locally re-captured with one `--gate-save`).
  The migration creates the new tables and drops the old ones — no row translation.

**Rationale:**

The `Signal.fingerprint?` slot already exists, unused, on the shared type — the
reconciling primitive is sitting there. The error rung (`SeverityPolicy.isError`),
`EXIT_CODES`, and `SignalEnvelope` are already shared. ADR-0035 just moved the
threshold half host-side and named this exact complement as out of scope, so the
seam is clean: the ratchet is the only remaining per-tool gate code. The two tools'
fingerprint policies are the one genuinely irreconcilable axis — hence the
strategy-injection design — but everything else (storage, diff, exit wiring,
export) is mechanical duplication that a single plane removes. Because each tool's
exit behavior on the ratchet is preserved (graph's strategy byte-for-byte, so its
git-trackable JSON baseline stays valid), the migration is verifiable per-tool, not
a behavioral guess.

**Consequences:**

- **`Signal.fingerprint` becomes first-class**, populated at signal creation by the
  tool's strategy; the plane never re-fingerprints (so changing a strategy is a
  deliberate, documented re-capture — the honest contract).
- **One table pair in `datastore`**; `fit_baseline`, `graph_baseline_signals`,
  `graph_baseline_meta`, both `persistence/baseline-repo.ts`, `fingerprint-signal.ts`,
  and `DEFAULT_VIOLATION_IDENTITY` are deleted. The `tool_baseline_meta` marker
  preserves graph's "empty-but-saved ≠ never saved" correctness, which fitness lacks.
- **The `payload` column is load-bearing, not optional** — it supplies the
  full-object `resolved` bucket *and* the SARIF re-render (`exportBaselineSarif`
  rebuilds `signals[]` from payloads into a *synthetic* envelope; sound because
  `formatSignalSarif` derives `results[]` from signals only). A bloat-driven
  minimal projection must still retain the SARIF-result + resolved fields.
- **Code placement:** pure diff + `GateCompareResult` in `@opensip-cli/output`
  (already the home of pure envelope transforms); `BaselineRepo` + migration in
  `datastore` (already centralizes baseline DDL); seams on `cli-context.ts`. Kernel
  `core` carries no persistence (dependency-cruiser-enforced).
- **`--gate-compare` exit (net-new → `RUNTIME_ERROR`) is distinct from ADR-0035's
  findings exit.** A tool may emit both. Whether the ratchet is hard-fail vs
  report-only is best expressed as a **third reserved config key** (`failOnDegraded`,
  default true) beside ADR-0035's `failOnErrors`/`failOnWarnings`, mirroring
  ADR-0020's `failOnErrors:0 = ratchet-only` idea — the implementing spec closes
  this.
- **graph's fingerprint strategy is byte-preserved.** Its JSON fingerprint baseline
  is a git-trackable artifact committed in consumer repos; the strategy must
  reproduce `ruleId|filePath|line|col` exactly (acceptance: byte-identical export).
- **Sequencing.** This work touches `graph-modes.ts` and the fitness gate path that
  the ADR-0035 build is also editing — it must land **after** the host-owned-verdict
  work, not concurrently.

**Related specs / ADRs:** Picks up the baseline-diff thread ADR-0035 deferred;
builds on ADR-0011 (Signal is the output currency — fingerprints + baseline are a
property of that currency) and ADR-0020 (dogfood gate hard-fail + net-new SARIF
ratchet — this plane generalizes the ratchet to every tool). The implementing spec
is a local implementation spec (local-only), which carries
the divergence table, the data model, the seam surface, and the per-tool no-flap +
byte-identical verification matrix.

---

## Amendment — 2026-07-07: occurrence-ordinal fingerprint disambiguation

The decision above is unchanged: the plane keys on the opaque `Signal.fingerprint`
and treats it as an identity it never re-derives. This amendment closes a
correctness hole in that identity — it does not reverse the decision.

**(a) Problem.** The plane keys entirely on the opaque `Signal.fingerprint`. A
per-tool `FingerprintStrategy.fingerprint` is a `(signal) => string` — it cannot
see its siblings — so two *distinct* findings that map to the same base
fingerprint collapse to a single entry. This happens for the two message-hash
strategies that deliberately drop line/col: two identical Python `except:` lines
under fitness's `sha256(filePath\nruleId\nmessage)`, or two vulns with the same
file+rule+message under a scanner's message-hash. The collapse occurs at BOTH host
consumption points — `diffBaseline` (a `Map` keyed by fingerprint, last-wins) and
`BaselineRepo.save` (fingerprint dedupe + the composite PK `(tool, fingerprint)`) —
so one real finding is silently dropped from the ratchet (the motivating `except:`
bug).

**(b) Decision.** Compute a per-run **occurrence ordinal** in the host
`stampFingerprints` (`core/src/baseline/fingerprint-strategy.ts`) — the single
production stamping point, which already receives the whole `Signal[]`. The tool's
per-signal strategy is untouched and still opaque. When 2+ un-stamped signals share
a base under `strategy`, the FIRST occurrence (array order) keeps the exact base
hash and each subsequent occurrence gets an `#<n>` suffix
(`OCCURRENCE_ORDINAL_SEPARATOR`). Singletons and the no-collision common case are
byte-identical to the bare base hash → **zero migration** for the common case, and
the golden per-strategy tests are unaffected because they call
`strategy.fingerprint()` directly, not through `stampFingerprints`. Pre-stamped
signals are opaque: they are excluded from grouping and returned by identity, so
idempotency is preserved.

**(c) Version surface.** Bump the two message-hash strategies —
`fitness.sha256-file-rule-message` and
`external-tool-adapter.sha256-file-rule-message` — to **version 2**, so a
pre-upgrade baseline that held a collapsed duplicate produces a clean
baseline-identity mismatch (`isBaselineIdentityCompatible`) → an explicit
re-capture prompt instead of a silent one-time spurious `degraded`. The hash
formulas are unchanged; only the descriptor `version` moves.
`graph.rule-file-line-col` (byte-preserved, git-tracked JSON baseline),
`opensip.default.rule-file-line-col`, and `yagni.sha256-detector-locations` stay
**version 1**: they carry positional/richer keys, never collide in practice, and
the ordinal is a no-op for them, so their byte/inheritance contracts are preserved
and no re-capture is forced.

**(d) Migration.** DB baselines are CI-ephemeral drop-and-recapture — one
`--gate-save` re-writes them. The graph git-tracked JSON fingerprint baseline file
is untouched (graph stayed at version 1). No `BASELINE_FORMAT_VERSION` change, no
datastore migration, and no `SignalEnvelope.schemaVersion` change: the
`tool_baseline_entries` / `tool_baseline_meta` tables are unchanged.
