---
status: proposed
last_verified: 2026-05-23
title: "Plan — split graph language adapters into separate packages"
audience: [contributors, architects]
related-audits:
  - ./2026-05-23-architecture-graph.md
  - ./2026-05-23-architecture-cli.md
related-plans:
  - ./2026-05-22-plan-layer-3-tools-and-lang.md
---
# Plan — split graph language adapters into separate packages

## Summary

Today `@opensip-tools/graph` ships as a single npm package containing
both the language-agnostic engine (lang-adapter contract, pipeline,
cache, rules, render, cli) **and** three language-specific adapter
subtrees (`lang-typescript/`, `lang-python/`, `lang-rust/`). The
adapters carry heavy parser dependencies (`typescript`, `tree-sitter`,
`tree-sitter-python`, `tree-sitter-rust`) that every consumer pays
for, regardless of which languages they use.

The fitness tool already established the right pattern for this:
language-specific surface ships as separate `@opensip-tools/checks-*`
packages, auto-discovered via `node_modules` walk, with the engine
itself adapter-free. Graph followed that pattern internally (per-
language subtrees inside the engine) but never paid down the
packaging side. We split now while it's a light lift; deferring it
gets harder as more adapters land (Java, Go, C/C++ are foreseeable)
and as third-party adapters become a real ask.

This plan introduces three new packages —
`@opensip-tools/graph-typescript`, `@opensip-tools/graph-python`,
`@opensip-tools/graph-rust` — and converts the graph engine into a
language-agnostic kernel that depends on **none** of them. Adapter
discovery lives in the graph engine (mirroring fitness's
`check-package-discovery`); registration happens in the CLI bootstrap
(mirroring how check packs are loaded).

The work is sequenced as three small PRs, each individually
shippable, each leaving the build green.

## Goals

1. The graph engine package depends on neither `typescript` nor any
   `tree-sitter-*` grammar.
2. Each language adapter ships as its own npm package with its own
   parser dependency, discoverable by name prefix
   (`@opensip-tools/graph-<lang>`).
3. First-party adapter wiring goes through the same auto-discovery
   path that third-party adapters will use — no privileged static
   import.
4. Existing dep-cruiser invariants (no parser leaks, language-pack
   isolation, peer-layer rules) are preserved or strengthened, never
   weakened.
5. CLI behavior is byte-identical from the user's perspective —
   `opensip-tools graph` resolves the right adapter for the cwd and
   produces the same output.

## Non-goals

- No changes to the `GraphLanguageAdapter` contract surface itself.
  The six-method contract and the nine I-1…I-9 invariants stay as
  they are.
- No new languages added. Java/Go/C-family adapters are out of scope;
  this plan only relocates the three that exist today.
- No `--language` CLI flag. The dominance heuristic in
  `pickAdapter()` keeps doing what it does.
- No fitness-side changes. Check packs are already split; this plan
  doesn't touch them.

## Decisions (locked)

The three open questions discussed in chat resolved as:

| Decision                        | Choice                                                |
| ------------------------------- | ----------------------------------------------------- |
| Naming                          | `@opensip-tools/graph-<lang>` (TS/python/rust)        |
| Discovery                       | Auto-discover via `@opensip-tools/graph-*` walk       |
| Registration                    | CLI registers in bootstrap (symmetric with fit packs) |

Naming rationale: hyphen prefix `graph-` is already an unused npm
namespace within `@opensip-tools/`, and it does not collide with
`@opensip-tools/lang-typescript` (the language adapter under
`packages/languages/` that fitness uses for AST helpers — entirely
distinct concept). The hyphen anchor lets the discovery walker match
`@opensip-tools/graph-*` without false-matching `@opensip-tools/graph`
itself.

## Target layout

```
packages/graph/
├── engine/                          # @opensip-tools/graph
│                                    #   (language-agnostic kernel)
├── graph-typescript/                # @opensip-tools/graph-typescript
├── graph-python/                    # @opensip-tools/graph-python
└── graph-rust/                      # @opensip-tools/graph-rust
```

Each adapter pack mirrors the fitness check-pack convention:

```
packages/graph/graph-<lang>/
├── package.json        # name, version, opensipTools.kind = "graph-adapter"
├── tsconfig.json
├── vitest.config.ts
└── src/
    ├── index.ts        # exports `adapter`, `metadata`, plus
    │                   #   helper re-exports for tests
    ├── cache-key.ts
    ├── discover.ts
    ├── parse.ts
    ├── walk.ts          (lang-typescript splits this further)
    ├── resolve.ts       (typescript: edges.ts + edge-resolvers/)
    ├── rule-hints.ts
    └── __fixtures__/    (where applicable)
```

The graph engine's tree shrinks correspondingly:

```
packages/graph/engine/src/
├── lang-adapter/        # GraphLanguageAdapter contract + registry +
│                        #   shared edge helpers (truncateForCallEdge,
│                        #   edge-text constants — promoted to barrel)
├── plugins/             # NEW — graph-adapter-discovery.ts
├── pipeline/            # incl. stages.ts (post-N-3)
├── cache/
├── rules/
├── render/
├── cli/
├── tool.ts
├── types.ts
├── errors.ts
├── gate.ts
└── index.ts
```

`bootstrap.ts` is **deleted**. The engine no longer knows about any
specific adapter.

## What stays in the engine

The split is "language-specific code moves out", not "everything
adapter-shaped moves out". A few things are deliberately kept in the
engine because every adapter pack consumes them:

- **`lang-adapter/`** — the `GraphLanguageAdapter` contract, the
  registry, **and `edge-helpers.ts`** (`truncateForCallEdge`,
  `CALL_EDGE_TEXT_MAX`, `CREATION_EDGE_PREFIX`,
  `CREATION_EDGE_TEXT_MAX`, `MutableStats`). The 2026-05-23 audit
  consolidated these into the contract layer because all three
  adapters were duplicating them; that consolidation must hold under
  the package split too. Adapter packs import them via
  `@opensip-tools/graph`'s public barrel after PR 1 promotes them.
- **`pipeline/stages.ts`** — the shared `GraphStage` /
  `GRAPH_STAGES` / `RebuildStage` vocabulary added in commit
  `b708d72`. Engine-internal; adapters never reference it directly.
- **`rules/`** — language-agnostic; consumes the frozen catalog only.

## Sequencing — three PRs

The split is sequenced so each PR ships green-build and the user-
visible behavior never regresses. Each PR is reviewable on its own.

### PR 1 — `graph-typescript` (the heaviest extraction)

Largest of the three because the TypeScript adapter is structurally
richer: `edge-resolvers/`, `inventory-visitors/`, `inventory.ts`,
`test-file.ts`, plus the `edges.ts` orchestrator. PR 1 also lands all
the shared infrastructure (discovery module, CLI bootstrap hook,
dep-cruiser deltas, doc updates), so PR 2 and PR 3 are pure
file-moves.

**Contents:**
1. New package `packages/graph/graph-typescript/`. Move every file
   under `packages/graph/engine/src/lang-typescript/` to its `src/`,
   preserving the internal directory structure (`edge-helpers/`,
   `edge-resolvers/`, `inventory-helpers/`, `inventory-visitors/`).
   Includes `test-file.ts` (added in 919b41a as the canonical
   `isTypescriptTestFile` predicate).
2. New module `packages/graph/engine/src/plugins/graph-adapter-discovery.ts`
   — modeled byte-for-byte on
   `packages/fitness/engine/src/plugins/check-package-discovery.ts`.
   Three resolution rules:
   - `plugins.graphAdapters: [...]` in config wins
   - `plugins.autoDiscoverGraphAdapters: false` opts out
   - Otherwise, walk ancestor `node_modules/@opensip-tools/`,
     return every directory matching `graph-<id>` (anchor on the
     hyphen so `graph` itself is not a match)
3. New CLI bootstrap module
   `packages/cli/src/bootstrap/register-graph-adapters.ts`. Calls
   discovery, dynamically imports each pack, calls
   `registerAdapter(mod.adapter)`. Sits next to
   `register-language-adapters.ts` and `register-tools.ts`. Hooked
   into `bootstrap/index.ts` before `mountAllToolCommands`.
4. **Promote contract surface from `engine/src/lang-adapter/`** into
   the engine's public `index.ts`:
   - Contract types: `GraphLanguageAdapter`, `DiscoverInput/Output`,
     `ParseInput/Output`, `WalkInput/Output`, `ResolveInput/Output`,
     `CallSiteRecord`, `AdapterCallConfidence`, `RuleHints`.
   - Edge-helper utilities: `truncateForCallEdge`,
     `CALL_EDGE_TEXT_MAX`, `CREATION_EDGE_PREFIX`,
     `CREATION_EDGE_TEXT_MAX`, `MutableStats`.
   These are the imports adapter packs need from
   `@opensip-tools/graph`.
5. Delete `packages/graph/engine/src/bootstrap.ts`. Remove its
   `import './bootstrap.js'` from `tool.ts`.
6. Move TS-specific types out of the engine's barrel:
   `EdgeResolver`, `ResolverContext`, `InventoryVisitor`,
   `VisitorContext` were re-exported from
   `packages/graph/engine/src/index.ts`. They now live in
   `@opensip-tools/graph-typescript`. Engine's barrel drops these
   four symbols.
7. Add `@opensip-tools/graph-typescript` as a CLI dep in
   `packages/cli/package.json`. Remove `typescript` as a runtime
   dependency of `@opensip-tools/graph` (engine no longer needs it
   at runtime; `tsc` for build remains under `devDependencies`).
8. Dep-cruiser updates (see §"Dep-cruiser deltas" below).
9. Release workflow updates (see §"Release workflow" below).
10. Doc updates (see §"Doc updates" below).
11. Test updates: any test that imported `typescriptGraphAdapter`
    from the engine now imports from `@opensip-tools/graph-typescript`.
    Stub `ToolCliContext` fixtures must include the `emitJson` seam
    added in commit `4448a63` — search-and-replace if any test
    constructs a context for a graph-adapter pack.

**Acceptance:**
- `pnpm typecheck && pnpm test && pnpm lint` clean (lint includes
  ESLint + dep-cruiser; both must be 0-error).
- `pnpm build && node packages/cli/dist/index.js graph` against this
  repo produces identical output to mainline.
- Engine package's `dependencies` list contains no parser packages
  (no `typescript`, no `tree-sitter*` at runtime).
- Discovery module finds and registers all three adapters at startup
  (verified via the absence of `cli.tool.load_failed` log lines and
  the adapter registry containing the expected three ids).

### PR 2 — `graph-python`

Pure file move + package wiring. Smaller than PR 1 because the
discovery, CLI bootstrap, dep-cruiser, and doc work all already
landed.

**Contents:**
1. New package `packages/graph/graph-python/`. Move
   `packages/graph/engine/src/lang-python/` → `src/`.
2. Add `@opensip-tools/graph-python` as a CLI dep.
3. Move `tree-sitter` and `tree-sitter-python` deps from the engine's
   `package.json` to `@opensip-tools/graph-python`.
4. Update dep-cruiser path patterns where they reference
   `lang-python` paths (most rules become unnecessary by virtue of the
   package boundary; see §"Dep-cruiser deltas").
5. Move `__fixtures__/` with the adapter — fixtures test the adapter
   in isolation, which now means in-package tests.
6. Update release workflow + RELEASING.md.

**Acceptance:**
- Same as PR 1 plus: a Python fixture (one of the existing graph
  adapter fixtures) renders the expected catalog.

### PR 3 — `graph-rust`

Same shape as PR 2.

**Contents:**
1. New package `packages/graph/graph-rust/`. Move
   `packages/graph/engine/src/lang-rust/` → `src/`.
2. Add `@opensip-tools/graph-rust` as a CLI dep.
3. Move `tree-sitter-rust` dep from engine to `@opensip-tools/graph-rust`
   (`tree-sitter` already moved with PR 2).
4. Dep-cruiser cleanup (engine source no longer contains any `lang-*`
   directory; the path-pattern rules can be deleted, not just
   rescoped).
5. Update release workflow + RELEASING.md.

**Acceptance:**
- Same as PR 2 plus: every `lang-*` reference in
  `.dependency-cruiser.cjs` paths is gone (rules either deleted or
  rewritten in package-name terms).

## Discovery semantics

The new module mirrors fitness's check-package discovery. Resolution
order, in execution sequence:

```
1. Read opensip-tools.config.yml
2. If plugins.graphAdapters is present:
     resolve each by name; warn-and-skip any not in node_modules
     return the resolved list (auto-discovery skipped)
3. Else if plugins.autoDiscoverGraphAdapters === false:
     return []
4. Else:
     walk ancestor node_modules/@opensip-tools/
     return every entry whose dir name matches /^graph-[a-z0-9-]+$/
     (excluding 'graph' itself)
```

A discovered adapter pack is expected to export
`{ adapter: GraphLanguageAdapter, metadata }` from its main entry.
Failures (missing export, bad shape, throw on import) follow the same
isolated-failure pattern the CLI uses for tool packages: log
`cli.graph_adapter.load_failed`, write a stderr line, continue.

## Dep-cruiser deltas

The current rules in `.dependency-cruiser.cjs` enforce per-subdirectory
discipline within a single package. After the split, package
boundaries enforce most of them automatically; what remains is
cross-package layering.

**Rules to delete (subsumed by package boundaries):**

| Rule                                                | Why deletable                                                           |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| `graph-no-typescript-import-outside-lang-typescript`| Engine package no longer depends on `typescript`; nothing to police     |
| `graph-no-tree-sitter-import-outside-lang-packs`    | Same — engine has no `tree-sitter*` dep                                 |
| `graph-orchestrate-no-direct-lang-import`           | `lang-*` directories no longer exist in the engine                      |
| `graph-pipeline-no-lang-import`                     | Same                                                                    |

**Rules to keep, repath:**

| Rule                                                | Change                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| `graph-visitors-resolvers-disjoint`                 | Repath from `engine/src/lang-typescript/...` to `graph-typescript/src/` |
| `graph-resolvers-visitors-disjoint`                 | Same                                                                    |
| `graph-rules-no-parser`                             | Drop `^typescript$` and `lang-typescript/` rows; engine can't reach them anyway |

**Rules to add:**

| Rule                                                | Purpose                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| `graph-engine-no-adapter-packs`                     | Engine MUST NOT depend on `@opensip-tools/graph-(typescript|python|rust)` |
| `graph-adapters-disjoint`                           | Adapter packs MUST NOT import each other                                |
| `graph-adapters-no-cli`                             | Adapter packs MUST NOT depend on `@opensip-tools/cli`                   |
| `graph-adapters-no-fitness`                         | Adapter packs MUST NOT depend on `@opensip-tools/fitness` (peer-layer)  |
| `graph-adapters-no-checks`                          | Adapter packs MUST NOT depend on `@opensip-tools/checks-*`              |

The result is the same architectural envelope, expressed in package
edges instead of path globs. That makes it stronger, not weaker —
package edges are also enforced by the package manager and by any
downstream consumer's lockfile, not just dep-cruiser.

## Release workflow

`.github/workflows/release.yml` and `RELEASING.md` change as follows.

**Package count:** 19 → 22.

**Preflight loop** (`for pkg in …`): add `graph-typescript graph-python graph-rust`.

**Pack step:** add three new `pnpm --filter @opensip-tools/graph-<lang> pack` lines, after the existing `graph` pack line.

**Publish order:** strict dependency order. Insert the three adapter
packs **between** the engine and the check packs:

```
core
contracts
lang-typescript … lang-cpp           (Brazil-side language adapters)
dashboard
fitness
simulation
graph                                  ← engine (publishes first)
graph-typescript                       ← NEW
graph-python                           ← NEW
graph-rust                             ← NEW
checks-universal … checks-cpp
cli                                    ← composition root
```

The CLI is the only consumer of the new packs, so they must publish
before CLI but after their own upstream (`graph`). Adapter packs
themselves are independent of each other, so their relative order
within the trio doesn't matter — alphabetical is fine.

`RELEASING.md`'s 19-row package table grows three rows; the
"Releasing" prose elsewhere references "19 packages" in two places
that need to bump to "22".

## Doc updates

| File                                          | Change                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `CLAUDE.md` repo-structure block              | Add `graph-typescript/`, `graph-python/`, `graph-rust/` rows under a new `graph/` namespace section |
| `CLAUDE.md` "Project Status"                  | Update package count if mentioned                                       |
| `RELEASING.md`                                | Add three rows to package table; update "19 packages" copy              |
| `docs/plans/architecture/2026-05-23-architecture-graph.md` | Section "Adapter packaging" added; finding about "single npm package" closed |
| `docs/plans/persistence-migration/`           | No change — adapter packs are not persistence concerns                  |

The graph architecture audit explicitly flagged the single-package
shape as a future packaging tension; this plan closes that finding.

## Risk register

| Risk                                            | Mitigation                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| Adapter discovery fails on pnpm-hoisted layouts | Mirror fitness's exact ancestor walk (already battle-tested)            |
| Re-export removal breaks downstream             | Engine is pre-1.0-style internal; the four removed re-exports (`EdgeResolver` etc.) move to `graph-typescript`. Migration is a single-line import change for any external consumer. |
| `lang-adapter/edge-helpers.ts` exports now public | Symbols promoted to the engine barrel become part of the v-current API surface. Acceptable: they were already shared infrastructure post-2026-05-23 audit (N-2). |
| Release ordering races                          | Workflow is sequential by design; `publish_if_new` is idempotent, so a re-run is safe |
| Test files importing `typescriptGraphAdapter` from engine | Search-and-replace in PR 1; CI catches any miss                         |
| Test fixtures missing `emitJson` on stub `ToolCliContext` | The seam added in commit 4448a63 is required on every stub context; PR 1's test sweep adds it where missing |
| Discovery skips an installed adapter            | Discovery + bootstrap log structured events on every load attempt; missing pack shows up as zero registered adapters and a hard `ConfigurationError` from `pickAdapter()` — loud, not silent |

## Out-of-scope follow-ups

These are intentionally not in this plan:

- A `--language` CLI flag for explicit adapter selection (`pickAdapter`'s heuristic stays).
- Third-party adapter authoring guide.
- Java/Go/C-family graph adapters (these will follow the same pattern when authored, but each is its own design effort).
- Plugin hook for non-discovery adapter sources (e.g. consuming an adapter from a sibling workspace package outside `@opensip-tools/`).
- Unifying tool-discovery (`opensipTools.kind === 'tool'`) and graph-adapter-discovery (`graph-*` prefix) under a single core "plugin discovery" module. They follow different shapes today and the duplication is small; collapse later if a third axis appears.

## Verification checklist

Before merging each PR:

- `pnpm install && pnpm typecheck && pnpm test && pnpm lint` (lint
  includes ESLint + dep-cruiser; both must be 0-error)
- `pnpm build && node packages/cli/dist/index.js graph` against the
  monorepo itself (TypeScript adapter resolves)
- Manual run against a Python fixture (PR 2) and a Rust fixture (PR 3)
- `git diff packages/graph/engine/package.json` shows parser deps
  decreasing as the work progresses (PR 1: drops runtime `typescript`;
  PR 2: drops `tree-sitter`, `tree-sitter-python`; PR 3: drops
  `tree-sitter-rust`)
- Release-workflow CI dry-run (the PR-checks job) packs all 22
  packages cleanly

## Appendix — alternatives considered

**A1. Keep adapters bundled, ship parser deps as `optionalDependencies`.**
Rejected. Optional deps still install by default; users would need to
explicitly opt out per parser, and the engine package would still
list every parser by name. Doesn't solve the lift-on-future-growth
problem this plan is solving.

**A2. One `@opensip-tools/graph-adapters` package containing all three.**
Rejected. Same drawback as today, just rebranded — every consumer
still pulls every parser. No improvement to install size or
authoring boundaries.

**A3. Auto-discover by `package.json` `opensipTools.kind === 'graph-adapter'`** (mirror tool-discovery rather than name prefix).
Considered. The tool-registry uses kind-based discovery; the
check-pack registry uses prefix-based. Either works. Prefix matches
fitness's check-pack flow, which is what this plan explicitly mirrors,
so we go with prefix. (The two could be unified later under a single
"plugin discovery" module in core; that's not this plan.)
