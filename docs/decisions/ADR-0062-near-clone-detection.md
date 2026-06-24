---
status: active
last_verified: 2026-06-24
owner: opensip-cli
---

# ADR-0062: Near-Clone Detection via Persisted MinHash

```yaml
id: ADR-0062
title: Near-Clone Detection via Persisted MinHash
date: 2026-06-24
status: active
supersedes: []
superseded_by: null
related: [ADR-0005, ADR-0006]
tags: [graph, rules, duplication]
enforcement: not-mechanizable
enforcement-reason: >
  Near-clone similarity is a heuristic policy choice (char shingles, LSH
  parameters, threshold). Population symmetry is verified by
  graph-equivalence-check, not a static fitness check.
```

**Decision:** Persist a walk-time MinHash signature (`bodySignature?`, k=128) on
each `FunctionOccurrence`, derived from the same normalized body string as
`bodyHash`, and evaluate near-clones in a new `graph:near-duplicate-function-body`
rule using LSH-banded Jaccard estimation, union-find clustering, and a same-language
gate on candidate pairs.

**Alternatives:**

- **Rule-time filesystem re-read** — rejected: violates ADR-0005 rule purity
  (rules receive only catalog + indexes + config).
- **AST/token fingerprints** — rejected for v1: higher adapter cost; char
  5-grams reuse the existing normalization pipeline with no new parser surface.
- **Lower k (e.g. 24)** — rejected: SE ≈ 0.073 at J=0.85 vs k=128 SE ≈ 0.031;
  false positives dominate at low k on a large catalog.
- **Cross-language near-clone clustering** — rejected: fuzzy char MinHash can
  score unrelated Go/TypeScript bodies ≥ threshold by coincidence; never actionable.

**Rationale:** `graph:duplicated-function-body` keys on `sha256(normalized body)`.
Copy-paste-with-edits is the more common tech-debt signal and produces a different
hash per drift. Computing signatures at walk time (both digest paths: tree-sitter
adapters and TypeScript `hash-body.ts`) keeps rule evaluation pure while making
near-clone detection O(n) via LSH instead of O(n²). LSH parameters
`(k, b, r) = (128, 8, 16)` are co-tuned so `(1/b)^(1/r) ≈ 0.878` ≈ the default
0.85 Jaccard threshold. Cache keys embed `sig=<k>.<algoVersion>` (e.g. `sig=128.2`)
so both a parameter change and an algorithm change invalidate stale catalogs
without a release bump — critically, this prevents mixing old- and new-algorithm
signatures across an incremental build, which would corrupt every Jaccard estimate.

**Signature algorithm (v2):** each char-5-gram shingle is hashed ONCE with SHA-256,
then the k MinHash values are derived by mixing that base hash with k fixed 32-bit
seeds (a division-free `Math.imul` avalanche). This is ~k× fewer SHA-256 calls than
the v1 "k independent SHA-256 per shingle" approach — measured **~66× faster** per
body (8.3 → 0.13 ms) — with identical MinHash semantics (the behavioural Jaccard
tests are algorithm-agnostic). `NEAR_DUP_SIGNATURE_VERSION` gates the cache key.

**Consequences:**

- `bodySignature` is internal persisted catalog data (like `bodySize`) — not
  promoted to `@opensip-cli/contracts` unless explicitly adopted later.
- Exact-duplicate pairs (`bodyHash` equal) are excluded from near-clone candidate
  edges; `duplicated-function-body` owns those.
- v1 is per-instance only (no cross-package aggregate path).
- Known limitations: char shingles are identifier-rename-sensitive; Python uses
  indentation-sensitive `normalizePythonBody`; absent `bodySignature` on legacy
  catalogs → rule emits nothing (graceful).
- `bodySignature` must be symmetric across exact and sharded builds; regressions
  are debugged via `GRAPH_EQUIV_DIAG=<path>` on `graph-equivalence-check`.
- `languageOfFile` lives in the engine (`lang-adapter/`) because the rule cannot
  import `graph-adapter-common` (layering cycle). It maps `.js`/`.jsx`/`.mjs`/`.cjs`
  to `typescript` (same adapter) so JS and `.ts`↔`.js` near-clones are detected.
- **Payload cost (measured):** a k=128 signature serializes to ~1.1 KB/function of
  JSON in the catalog's `payload` column — ~25 MB for this ~22.5k-function repo
  (~14 MB gzipped), ~1 MB per 1000 functions. This is **cache-only** — it lives in
  the gitignored `.runtime` sqlite store (CI-ephemeral), is NOT in the published
  package, and is NOT in the `graph export --format catalog` wire format. k=128 is
  retained for accuracy (SE ≈ 0.031); k=64 or a packed binary encoding are future
  options only if a very-large-repo consumer hits a memory/cache ceiling.

**Related specs / ADRs:** ADR-0005 (rule purity), ADR-0006 (derived data
persistence).