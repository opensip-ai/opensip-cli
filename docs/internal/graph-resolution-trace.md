# Graph resolution trace (`GRAPH_SITE_LOG`)

A debug-only, env-gated harness for diagnosing **exact ↔ sharded** call-graph
resolution divergence at per-call-site granularity. It is OFF with zero
production cost unless `GRAPH_SITE_LOG` is set, and it lives in two isolated
modules (one per package) so the production resolvers stay registry-clean:

- `packages/graph/graph-typescript/src/edge-helpers/resolution-trace.ts`
  → `traceResolveDecl` — one row per `resolveDeclToHash` decision (the exact
  engine's type-checker-driven hop: in-project hash vs. `.d.ts` boundary
  re-resolution vs. file+name pin vs. decline).
- `packages/graph/engine/src/cli/orchestrate/resolution-trace.ts`
  → `traceResolveOne` — one row per cross-shard `resolveOne` decision (the
  sharded engine's post-merge boundary linker: relative-pin vs.
  workspace-export vs. decline). The exact engine routes its recovered
  boundary calls through the SAME linker (`recoverExactBoundaryEdges` in
  `cache-orchestrator.ts`), so this row covers both engines.

Both modules carry `@fitness-ignore-file env-via-registry` (the direct
`process.env` reads are an intentional, isolated debug exception, not
production config) and `/* v8 ignore */` (they are exercised manually, not in
the suite).

## Why it exists

This harness root-caused the divergence classes the
`graph-resolution-correctness` work converged (204 → 12 production resolved-edge
divergences). The key lesson: **join on the full project-relative
`ownerFile:line:column`**, never a coarse `owner|callee` or `owner-base:line`
key — coarse keys collide across same-name call sites and produced four
mis-diagnoses before the full-path harness made the per-site verdict
unambiguous. Both modules emit the full-path key for exactly this reason.

## Usage

```bash
# Capture the exact engine's per-site decisions
GRAPH_SITE_LOG=/tmp/exact.tsv GRAPH_ENGINE=exact \
  node packages/cli/dist/index.js graph --exact >/dev/null

# Capture the sharded (default) engine's per-site decisions
GRAPH_SITE_LOG=/tmp/sharded.tsv GRAPH_ENGINE=sharded \
  node packages/cli/dist/index.js graph >/dev/null

# Join on the ownerFile:line:column key to find sites that diverge.
```

`GRAPH_ENGINE` is a free-form label written verbatim into column 1 — set it to
whatever distinguishes the two runs you are comparing.

## Relationship to the equivalence guardrail

The committed guardrail is `graph-equivalence-check` (budget in
`.config/graph-equivalence-budget.json`); it reports the *count* of production
resolved-edge divergences. This trace is the *investigative* tool you reach for
when that count moves and you need to know **which** sites and **why**. Start
from measurement here, not a rebuilt harness — that is the whole reason it is
kept rather than deleted after each investigation.
