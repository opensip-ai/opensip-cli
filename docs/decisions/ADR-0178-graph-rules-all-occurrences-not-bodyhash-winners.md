---
status: active
last_verified: 2026-07-20
owner: opensip-cli
---

# ADR-0178: Graph occurrence-local rules and hash features consume all body twins

```yaml
id: ADR-0178
title: Graph occurrence-local rules and hash features consume all body twins
date: 2026-07-20
status: active
supersedes: []
superseded_by: null
related: [ADR-0003, ADR-0001, ADR-0136]
tags: [graph, rules, indexes, body-twins, inTestFile]
enforcement: mechanizable
enforced-by: ['script:body-twin-occurrence-rules.test']
enforcement-reason: >
  body-twin-occurrence-rules.test proves a production occurrence is still
  evaluated when a same-body test twin wins the byBodyHash last-writer slot
  (large-function / wide-function / high-blast-untested skip inTestFile on the
  winner only under the old contract).
```

**Decision:** Occurrence-local graph rules and twin-sensitive feature predicates
must **not** iterate `indexes.byBodyHash` alone as their complete occurrence
inventory. `byBodyHash` remains a last-writer-wins content-dedup map for hash-
keyed adjacency and cheap one-row features; **rules that gate on
`inTestFile`, location, params, or visibility consume every occurrence** via
`indexes.occurrencesByHash` (or a shared `eachOccurrence` helper). Hash-level
features that ask “is this body test code?” use a **twin union** over
`inTestFile` (any / every as the predicate requires), not the winner’s bit.

**Alternatives:**

- *Keep winner-only rule loops (status quo).* Rejected: a production function
  whose body is cloned in a test file can lose the `byBodyHash` slot to the
  test twin; rules that `continue` on `occ.inTestFile` then silently skip the
  production site — false green on large-function, wide-function,
  high-blast-untested, and related gates.
- *Drop `byBodyHash` entirely and key everything by occId.* Rejected: call
  adjacency and blast are still body-hash graphs (ADR-0003 twin-aware edges);
  eliminating the content map rewrites the kernel without fixing the consumer
  contract.
- *Prefer production over test when filling `byBodyHash`.* Rejected: still one
  representative; location/params can differ per occurrence; softens rather
  than removes dual consumer contracts (adjacency already twin-aware).

**Rationale:** ADR-0003 made adjacency twin-aware through `occurrencesByHash`
while leaving `byBodyHash` as last-writer-wins content dedup. Rules and some
feature seeds continued to walk winners only, so the index plane had two
consumer contracts. Cycle already resolves members via `byOccId` and treats
test-only SCCs by scanning every resolvable member’s `inTestFile`. Occurrence-
local quality gates must match that posture: evaluate each occurrence (or union
twin test-ness for hash features), so a test twin never masks a production twin.

**Consequences:**

- Shared helpers (`eachOccurrence`, `anyTwinInTestFile`, `everyTwinInTestFile`)
  live at the graph engine root (rules-safe; not under pipeline/) and are the preferred rule/feature iterators.
- Rules updated: large-function, wide-function, high-blast-untested,
  orphan-subtree, test-only-reachable, no-side-effect-path,
  always-throws-branch; entry-point inference walks all occurrences;
  package-coupling and test-reachability seeds use twin-aware `inTestFile`.
- `byBodyHash` remains valid for hash-keyed feature rows (bodyLines/blast) and
  adjacency key presence; documentation on `Indexes` states the consumer split.
- Regression: production twin + test twin, test inserted last → production still
  flagged when over threshold / untested high-blast.

**Related ADRs:** ADR-0003 (per-occurrence / twin-aware edges), ADR-0001
(actionable precise bounded rules), ADR-0136 (full occurrence identity).
