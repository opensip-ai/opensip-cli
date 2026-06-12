---
status: active
last_verified: 2026-06-04
owner: opensip-cli
---

# ADR-0010: `lang-*` is the single canonical parse + AST substrate for the whole platform

```yaml
id: ADR-0010
title: lang-* is the single canonical parse + AST substrate for the whole platform
date: 2026-06-04
status: active            # active | superseded | deferred
supersedes: []
superseded_by: null
related: [ADR-0009, DEC-521]   # DEC-521 (parent): opensip-cli = open deterministic signal foundry
tags: [architecture, languages, parsing, tree-sitter, polyglot, fitness, graph]
enforcement: mechanizable
enforcement-reason: >
  A dependency-cruiser rule restricts construction of a tree-sitter Parser (and
  import of the `web-tree-sitter` / grammar packages) to the `lang-*` packages;
  every other package — including the graph adapters and `graph-adapter-common`
  — must obtain parsed trees by importing the relevant `@opensip-cli/lang-*`.
  The rule activates per-language as each `lang-*` adapter gains its real parser
  (it would false-fire against `graph-adapter-common` mid-migration), matching
  the existing `graph-typescript → lang-typescript` precedent.
```

**Decision:** Each `@opensip-cli/lang-<language>` package is the **one
canonical place that parses that language** and exposes its AST + the
fit-friendly navigation helper vocabulary. **Both consumers — fitness checks
*and* graph adapters — depend on `lang-*` for parsing.** The tree-sitter
parsing primitives that today live in `packages/graph/graph-adapter-common`
move down into the `lang-*` adapters (the language-agnostic pieces into a
primitive shared *by* `lang-*`); `graph-adapter-common` and the
`graph-python/rust/go/java` adapters are refactored to consume `lang-*` instead
of parsing independently. `MinimalTextTree` is retired per-language as each
adapter gains a real tree-sitter parser; the branded `XTree` aliases become
real tree types.

**Alternatives:**

- *New shared low-level package (`tree-sitter-core`) that both `lang-*` and
  `graph-adapter-common` depend on.* Rejected: it leaves the platform
  asymmetric — graph would consume `lang-typescript` for TS (existing edge) but
  a separate `tree-sitter-core` for the other languages. Two patterns for "parse
  a language," and `lang-*` would still not be the single substrate. Lower churn
  to graph, but not the correct end-state.
- *Copy/duplicate tree-sitter parsing into `lang-*` independently of graph.*
  Rejected: two tree-sitter parsers per language (graph's and fit's) that drift,
  and the same file gets parsed twice. A band-aid that adds debt.
- *Keep `MinimalTextTree`; author non-TS checks as text/regex only.* Rejected:
  caps non-TS fitness at the text tier forever — no enclosing-function,
  structural, or AST-aware checks — so never real parity with TypeScript.

**Rationale:** The correct end-state already exists *for TypeScript* and proves
the shape: `graph-typescript` depends on `@opensip-cli/lang-typescript`, so
`lang-typescript` is the single TS parse substrate consumed by both the graph
tool and fitness checks. The other languages never followed the pattern:

- `graph-adapter-common` already carries the mature non-TS tree-sitter
  vocabulary — `createTreeSitterParseProject`, `TreeSitterParsedFile/Project`,
  `childrenOf`, `namedChildrenOf`, `nameOf`, `runWalk`, `body-digest`,
  `cache-key`, file classifier — and `graph-python/rust/go/java` parse through
  it (they do **not** depend on `lang-*`).
- The fit-side `lang-go/java/rust/python` adapters ship *no real parser*:
  `packages/core/src/languages/text-tree.ts` states plainly that "tree-sitter
  integration is deferred," and `parse<Lang>()` returns a `MinimalTextTree`
  (source + line index). Every non-TS check today is a regex; `checks-<lang>`
  holds one check each.

So the work is not "invent a parser" — it is **finish the unification the TS
path already started**: make `lang-*` canonical for every language, point the
graph adapters at it (generalizing an *already-legal* `graph → lang` edge), and
delete graph's duplicate parsing. The shared parse routes through `core`'s
existing `parse-cache` so fitness and graph never double-parse a file. This is
the only option whose end-state is a single per-language substrate with two
consumers; per the standing principle, we take the correct architecture and
absorb the refactor cost.

**Consequences:**

- **`lang-*` grows up.** Each `lang-<language>` gains a real tree-sitter parser
  and an AST-navigation helper vocabulary approaching the ~30-helper surface of
  `lang-typescript` (the cross-language analog of `walkNodes` /
  `findEnclosingFunction` etc.). This is the Tier-A substrate that unblocks
  AST-level `checks-<language>` (Tier B).
- **Parsing primitives relocate.** The language-agnostic tree-sitter scaffolding
  in `graph-adapter-common` (parse-project, walk, name/children accessors,
  cache-key) moves to a primitive consumed *by* `lang-*`; `graph-adapter-common`
  becomes a thin consumer. Care required: round-3's body-digest hoist into the
  graph engine and the sharded / fast-resolution / per-shard-cache machinery sit
  on this layer — the relocation must preserve those.
- **Dependency edges flip for non-TS graph adapters.** `graph-python/rust/go/java`
  add a dependency on `lang-python/rust/go/java` and drop their independent
  parse, mirroring `graph-typescript → lang-typescript`. dependency-cruiser
  layer rules are updated to permit `graph-* → lang-*` for all languages and to
  forbid tree-sitter `Parser` construction outside `lang-*` (per-language
  activation).
- **`MinimalTextTree` is retired** as each language migrates; the `XTree` brand
  aliases become real tree types. The text-only path remains valid only for
  languages not yet migrated and for genuinely text-level checks.
- **Phased delivery.** Per language: (1) lift the parser into `lang-<language>`
  + helper vocabulary; (2) repoint that language's graph adapter; (3) author the
  high-value AST checks in `checks-<language>`. Languages migrate independently;
  the dep-cruiser rule arms per language as it lands.
- **Sequencing note:** this is the polyglot Tier-A workstream referenced by the
  strategy memo (`opensip/docs/business/2026-06-04-current-state-and-strategy.md`).
  It gates real (non-regex) non-TS parity for the open deterministic signal
  foundry (DEC-521).

**Related specs / ADRs:** [ADR-0009](./ADR-0009-public-api-surface-policy.md)
(public-API surface discipline — the relocated primitives must land behind
curated barrels / `internal` subpaths); parent-repo **DEC-521** (detection
boundary — opensip-cli as the open, deterministic, polyglot signal foundry).
A phased implementation spec should follow under `docs/plans/specs/`.
