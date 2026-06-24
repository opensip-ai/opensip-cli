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
0.85 Jaccard threshold. Cache keys embed `sig=128` so in-branch schema changes
invalidate without a release bump.

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
  import `graph-adapter-common` (layering cycle).

**Related specs / ADRs:** ADR-0005 (rule purity), ADR-0006 (derived data
persistence).