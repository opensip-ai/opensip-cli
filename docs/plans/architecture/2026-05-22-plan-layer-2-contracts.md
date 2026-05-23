---
status: current
last_verified: 2026-05-22
title: "Layer 2 (contracts) — remediation plan"
audience: [contributors, architects]
related-audits:
  - ./2026-05-22-architecture-contracts.md
  - ./2026-05-22-architecture-cli.md
---
# Layer 2 (contracts) — remediation plan

## Summary

`@opensip-tools/contracts` is structurally sound at the type level — the
`CommandResult` discriminated union, `EXIT_CODES`, and the
`configurePersistencePaths`-gated session writer are the right shapes
and should not change. The package's actual problem is its centre of
mass: ~80% of the lines under `packages/contracts/src/` render an HTML
report, not declare contracts. Until the dashboard subtree leaves, the
package's name does not match its content, the third-party Tool
dependency closure carries 2,000 LOC of view templates it does not need,
and several of the smaller findings (the positional `generateDashboardHtml`
signature, the duplicated Code Paths views, the `panelOrchestratorJs`
cross-tab handshake) can only be fixed in a context where it is safe to
break the renderer's import surface.

The biggest fix, then, is the dashboard split into a new
`@opensip-tools/dashboard` package — finding #5 — and that move is the
hinge of this plan. After it lands, the remaining seven findings either
collapse into the new package's first cleanup pass (#1, #2, #7, #8) or
become small, focused changes inside what's left of contracts (#3, #4,
#6). One finding (#6, `CliArgs`) is largely a documentation/policy
deprecation rather than a code change and is deferred to a CHANGELOG
note in the final phase.

## Sequencing rationale

Phases are ordered to avoid throw-away work and to keep each PR scoped.

1. **Finding #3 (`getErrorSuggestion`) goes first.** It is local to
   `exit-codes.ts`, touches no dashboard code, and is also called out by
   the CLI audit as F4. Landing the data-driven table here lets the CLI
   plan's F4 become "wire the CLI catch handler through the existing
   table"; landing it later would force the CLI plan to either duplicate
   the work or wait. This is the cheapest way to make the Layer 2 fix
   self-sufficient with respect to the CLI audit.

2. **Finding #4 (`StoredSession` / `FindingOutput` consolidation) goes
   second.** It touches `types.ts` and `persistence/store.ts` only, has
   no overlap with the dashboard subtree, and reduces the number of
   shapes the dashboard generator will have to consume after the split.
   Doing it before the split keeps the move in phase 3 mechanical.

3. **Finding #5 (the dashboard package extraction) is the central
   phase.** It must land **before** any internal cleanup of the
   renderer (findings #1, #2, #7) — there is no point cleaning up files
   you are about to move. The phase explicitly handles the workspace
   addition, dep-cruiser rule migration, RELEASING.md update, and the
   one-import change in fitness.

4. **Findings #1, #2, #7 (renderer-internal cleanups) all happen
   inside the new `@opensip-tools/dashboard` package.** Grouping them
   into one phase is deliberate: they share a context (the dashboard
   generator and Code Paths subsystem), they are mechanically similar
   refactors, and shipping them together lets the new package's first
   minor version present a clean public surface
   (`generateDashboardHtml({ ... })` with options object, registry-based
   tab handoff, and a `defineRankedView` helper). Splitting these
   across PRs would mean three rounds of touching the same files.

5. **Finding #6 (`CliArgs` deprecation) and finding #8 (barrel
   hygiene) are deferred to a documentation-only phase.** #8 resolves
   automatically when the dashboard splits out (the audit explicitly
   says so) and is verified rather than implemented. #6 is a slow-burn
   policy change — flagging it in CHANGELOG and docs is the right
   move, not a rip-out.

## Phase 1 — Make `getErrorSuggestion` data-driven

**Goal:** Replace the six-arm `if (message.includes(...))` chain in
`exit-codes.ts` with a flat `{ match, suggest }` rule table so adding a
new error category is one tuple, and so the CLI audit's F4 can wire its
catch handler through the same table without further refactor.

**Closes findings:** F3 (Layer 2 audit). Coordinates with CLI audit F4
(the CLI's own catch-handler wire-up is owned by the CLI plan and is
out of scope here, but this phase removes the upstream blocker).

**Files touched:**
- `packages/contracts/src/exit-codes.ts`
- `packages/contracts/src/__tests__/exit-codes.test.ts` (add cases)
- `packages/contracts/src/index.ts` (no export change unless we expose
  the rule-table type)

**Steps:**
1. In `exit-codes.ts`, declare an internal `SUGGESTION_RULES` array of
   `{ match: (msg: string) => string | null; suggest: (capture: string | null) => ErrorSuggestion }`
   tuples — one entry per existing `if`-arm, in the current evaluation
   order (preserve behavior).
2. Replace the function body of `getErrorSuggestion` with a single walk
   that returns the first hit, falling back to the existing default
   `RUNTIME_ERROR` shape.
3. Tighten the regex/capture for the "Check not found" arm so it lives
   in the rule's `match` rather than inline in the function.
4. Narrow the over-broad `'config'` substring rule into two explicit
   rules: one for `opensip-tools.config.yml` (file-shaped) and one for
   `YAML` (parse-shaped). Drop the bare `'config'` substring — its
   false-positive surface (`'configurable'`, `'reconfig'`, etc.) is the
   bug the audit flags.
5. Add table-driven tests covering each rule plus the default
   fall-through. Ensure existing `getErrorSuggestion` callers still
   produce the same `ErrorSuggestion` for the same inputs.
6. Do **not** introduce a Chain-of-Responsibility class. The audit's
   non-finding section explicitly rejects that shape; a flat array is
   the contract here.

**Acceptance:**
- `pnpm --filter=@opensip-tools/contracts test` passes with the new
  table-driven cases.
- `getErrorSuggestion` exports unchanged; no consumer in `cli`,
  `fitness`, `simulation`, or `graph` needs to change.
- A search for `message.includes(` in `exit-codes.ts` returns zero hits.
- `pnpm typecheck && pnpm lint` clean.

**Risk / dependencies:**
- Behavior parity is the whole point. The diff is mechanical but the
  evaluation order matters — the original first-match-wins semantics
  must be preserved exactly. Snapshot tests against the existing arm
  outputs are the safety net.
- No dependency on other phases. Can land independently.

---

## Phase 2 — Consolidate `Finding` / `CheckResult` shapes

**Goal:** Have one canonical `Finding` and `CheckResult` declared in
`types.ts`, imported by `StoredSession` and `FitDoneResult.findings`.
Remove the silent `severity: string` weakening in `StoredSession` by
introducing an explicit `LegacyStoredSession` type plus a `migrate`
step for older session JSON.

**Closes findings:** F4.

**Files touched:**
- `packages/contracts/src/types.ts`
- `packages/contracts/src/persistence/store.ts`
- `packages/contracts/src/__tests__/store.test.ts` (legacy-migration
  case; existing pinned shapes update only as needed)
- `packages/contracts/src/index.ts` (export `LegacyStoredSession` if
  needed by tests; otherwise keep internal)

**Steps:**
1. In `types.ts:112-128`, promote `FindingOutput` and `CheckOutput` to
   the canonical declaration. Confirm the `severity: 'error' | 'warning'`
   union is the intended set (cross-check against fitness's writer
   path).
2. Replace the inlined finding shape inside `StoredSession`
   (`store.ts:25-57`) with a re-import of `CheckOutput`/`FindingOutput`
   from `./types.js`.
3. Replace the inlined finding shape inside `FitDoneResult.findings`
   (`types.ts:176-210`) with `{ checks: CheckOutput[] }`. This is the
   third copy and removing it is the point of the phase.
4. Add `LegacyStoredSession` — a type that accepts `severity: string`
   and any other fields the old format permitted — plus a small
   `migrateLegacyStoredSession(raw): StoredSession` function inside
   `store.ts`. `loadSessions` and `clearSessionsOlderThan` route old
   files through `migrate`; new files write the strict shape.
5. Add a test that loads a fixture written under the old format and
   asserts it round-trips through `migrate` correctly.

**Acceptance:**
- `Finding`/`CheckOutput` declared once. Search for the second/third
  copy returns zero hits.
- `StoredSession.checks[].findings[].severity` is `'error' | 'warning'`,
  not `string`.
- Loading a legacy fixture (severity `"info"` or any other off-union
  string) does not throw — it migrates.
- `pnpm test && pnpm typecheck && pnpm lint` clean.

**Risk / dependencies:**
- Test fixtures pin specific shapes today; updating them is part of the
  diff. Use `git grep '\"severity\":'` under `packages/` to find every
  fixture that needs review.
- No dependency on phase 1. Can run in parallel; ordered second so the
  dashboard split (phase 3) consumes the consolidated shapes.

---

## Phase 3 — Extract `@opensip-tools/dashboard` package

**Goal:** Move the dashboard renderer subtree out of `contracts` into a
new `@opensip-tools/dashboard` package. After this phase, `contracts`
contains contract types, the exit-code helper, and `persistence/store.ts`
only. Fitness's `cli/dashboard.ts` imports `generateDashboardHtml` from
the new package.

**Closes findings:** F5. Sets up #1, #2, #7, #8.

**Layer position — argument and decision:**

The new package sits at **Layer 3 — peer to `fitness`, `simulation`,
`graph`, and the `lang-*` adapters**, NOT in a new layer between
contracts and tools.

Reasons (cross-checked against
`docs/architecture/10-mental-model/03-modular-monolith.md` and
`docs/architecture/90-conventions/02-layer-policy.md`):

- The dashboard *consumes* contracts (it reads `StoredSession` and the
  `GraphCatalog` JSON shape). It does not *define* a contract that
  every tool depends on, so it cannot sit between contracts and tools
  — that slot is reserved for things every tool needs.
- The dashboard does not need to be visible to tools that only want to
  emit JSON sessions. Putting it at Layer 3 means a third-party Tool
  that does not care about the report can depend on `contracts`
  without dragging dashboard code into its closure. This is exactly
  the dependency-closure win finding #5 calls out.
- Layer 3 already houses peers that consume contracts and may
  cross-import each other under documented exceptions
  (`lang-typescript → fitness`, `graph → fitness/sarif`). The dashboard
  fits the same shape: a package one level above contracts that the
  CLI / fitness can pull in when they need it.
- The audit's recommendation says "depends on `contracts`" — Layer 3
  is the layer that depends only on `contracts` and `core`. Anything
  higher (Layer 4 / 5) would force the dashboard to also know about
  check packs or the CLI, which it does not need.

**Files touched:**
- New: `packages/dashboard/` (mirrors the existing per-package layout
  used by tool engines):
  - `packages/dashboard/package.json` — name `@opensip-tools/dashboard`,
    same version as the rest of the workspace, `dependencies: { "@opensip-tools/core": "workspace:*", "@opensip-tools/contracts": "workspace:*" }`,
    same `scripts`/`tsconfig.json` shape as
    `packages/contracts/package.json`.
  - `packages/dashboard/tsconfig.json`
  - `packages/dashboard/src/index.ts` — barrel exporting
    `generateDashboardHtml` and the `GraphCatalog` *runtime*-shaped
    helpers (the `code-paths/types.ts` *type* re-export stays in
    contracts; only runtime exports move).
  - `packages/dashboard/src/generator.ts` — moved from
    `packages/contracts/src/persistence/dashboard/generator.ts`.
  - `packages/dashboard/src/css.ts`, `overview.ts`, `recipes.ts`,
    `sessions.ts`, `shared.ts`, `tool-tabs.ts`, `code-paths.ts`,
    `checks.ts` — all moved.
  - `packages/dashboard/src/code-paths/**` (the entire 18-file
    subtree, including `view-*.ts`).
  - `packages/dashboard/src/__tests__/` — moved test files.
- Deleted: `packages/contracts/src/persistence/dashboard/` (entire
  subtree).
- Edited: `packages/contracts/src/index.ts` — remove the
  `generateDashboardHtml` runtime export and the dashboard-only barrel
  group; keep `GraphCatalog`-typed re-exports if any still need to live
  here for contract reasons (the audit's wording — "the
  `GraphCatalog`/`StoredSession` *type* re-exports stay in contracts" —
  is the rule).
- Edited: `packages/fitness/engine/src/cli/dashboard.ts` — change one
  import from `@opensip-tools/contracts` to `@opensip-tools/dashboard`.
- Edited: `packages/fitness/engine/package.json` — add
  `"@opensip-tools/dashboard": "workspace:*"` to `dependencies`.
- Edited: `pnpm-workspace.yaml` — no change needed (`packages/*` already
  matches `packages/dashboard`).
- Edited: `.dependency-cruiser.cjs` — see "dep-cruiser rule changes"
  below.
- Edited: `RELEASING.md` — package count 18 → 19, add the new package
  to the table and to the publish-order list (between contracts and
  the language adapters; depends on contracts only, has no downstream
  dependents besides fitness).
- Edited: `tools/verify-release.mjs` and any release-helper script
  that hard-codes the package count or list (search for the literal
  `18` and the package list).
- Edited: `tools/oop-smoke/` and `tools/bootstrap-publish.sh` if they
  hard-code the package list.
- Edited docs: see "documentation updates" below.

**Steps:**
1. Create `packages/dashboard/` skeleton (`package.json`,
   `tsconfig.json`, `src/index.ts`, `__tests__/`). Mirror
   `packages/contracts/` exactly except for name and dependencies.
2. Move every file under
   `packages/contracts/src/persistence/dashboard/` to
   `packages/dashboard/src/` preserving the `code-paths/` subdirectory.
   Use `git mv` so blame stays intact.
3. Update internal imports inside the moved files: any
   `from '../../...'` paths that crossed back into other dashboard
   modules become local relative imports inside the new package; any
   import of types from contracts (e.g. `StoredSession`,
   `CheckCatalogEntry`) becomes `from '@opensip-tools/contracts'`.
4. Update `packages/contracts/src/index.ts`: remove
   `export { generateDashboardHtml } from './persistence/dashboard/index.js';`
   and the dashboard re-export block. Keep the `GraphCatalog`-shaped
   *type* re-exports — they stay in contracts as the contract surface
   between the graph tool and the dashboard.
5. Update `packages/fitness/engine/package.json` and
   `packages/fitness/engine/src/cli/dashboard.ts`:
   `import { generateDashboardHtml } from '@opensip-tools/dashboard';`.
6. Update `.dependency-cruiser.cjs` — see below.
7. Update `RELEASING.md`: bump 18 → 19 in the prose, add a row to the
   package table, slot the new package into the publish-order list at
   position 3 (after contracts, before language adapters). Note
   trusted-publisher bootstrap will be required on first publish (the
   `Bootstrapping a brand-new package` section already documents this
   path; reference it).
8. Update `tools/verify-release.mjs` package list and any other
   tooling that enumerates packages.
9. Update docs (see below).
10. Run `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm test`,
    `pnpm lint`. The dashboard's behavior must not change — its tests
    move with it and continue to pass.

**Dep-cruiser rule changes (`.dependency-cruiser.cjs`):**
- Add `dashboard-imports-only-core-contracts`: `from
  ^packages/dashboard/src/`, `to` forbidden list mirrors
  `contracts-imports-core-only` plus `^@opensip-tools/contracts` is
  *allowed* (whereas `contracts-imports-core-only` forbids
  contracts-from-contracts trivially). The dashboard depends on
  `core` and `contracts`; nothing else.
- Migrate the existing dashboard rules (whose `from` paths today are
  `^packages/contracts/src/persistence/dashboard/...`) to the new
  package paths:
  - `dashboard-no-graph-import`: `from`
    `^packages/dashboard/src/code-paths`.
  - `dashboard-code-paths-self-contained`: `from`
    `^packages/dashboard/src/code-paths/`, allow imports from
    `@opensip-tools/contracts` and dashboard siblings; forbid other
    workspace packages.
  - `dashboard-views-disjoint`: `from` and `to` paths both update
    to `^packages/dashboard/src/code-paths/view-`.
  - `dashboard-algorithms-no-view-deps`: paths update to
    `^packages/dashboard/src/code-paths/(scc|search|trace)\.ts$` and
    `^packages/dashboard/src/code-paths/(view-|function-card\.ts)`.
  - `dashboard-no-side-stylesheets`: `from`
    `^packages/dashboard/src/`.
  - `dashboard-no-ui-framework`: `from`
    `^packages/dashboard/src/`.
- Add `fitness-may-import-dashboard` (allow rule, severity
  `info` or simply not present; only needed if a forbidden rule would
  catch this edge — it should not, since fitness → dashboard is upward
  at the same layer with no cycle).
- Tighten `contracts-imports-core-only` if needed to also forbid
  `^@opensip-tools/dashboard` (it should already be covered by the
  default-deny shape; verify).

**Documentation updates:**
- `docs/architecture/10-mental-model/03-modular-monolith.md` — the
  five-layer ASCII diagram lists `fitness simulation graph lang-*` at
  Layer 3; add `dashboard`. Bump the "Eighteen packages" prose to
  "Nineteen packages." Update the `## The five layers` Layer 3
  paragraph to name the dashboard.
- `docs/architecture/90-conventions/02-layer-policy.md` — document
  the new `dashboard-imports-only-core-contracts` rule; update the
  panel-isolation rule paths to point at the new package; if the
  audit's "documented exceptions" need a note about
  `fitness → dashboard`, add it.
- `docs/architecture/80-reference/01-package-catalog.md` — add a
  `@opensip-tools/dashboard` entry with its one-line role and key
  exports.
- `docs/architecture/70-surfaces/03-dashboard.md` — update any "lives
  in contracts" wording to "lives in `@opensip-tools/dashboard`".
- `CLAUDE.md` (project root) — update the repository-structure tree
  diagram and the package count if it appears.
- `README.md` — update if it mentions the package count.

**Acceptance:**
- `pnpm build` produces `packages/dashboard/dist/`.
- `pnpm test` passes; the moved dashboard test files run under the
  new package.
- `pnpm lint` clean: dependency-cruiser passes with the migrated
  dashboard rules.
- `git grep "from '@opensip-tools/contracts'" packages/fitness/` shows
  no dashboard-shaped imports remain.
- `git grep "persistence/dashboard"` returns zero hits in `packages/`.
- `pnpm verify-release --expected-version <current>` passes (after
  updating `tools/verify-release.mjs` for the new package).
- The third-party-tool dependency-closure check: a hypothetical Tool
  that depends only on `@opensip-tools/contracts` no longer pulls
  any dashboard files. Spot-check by listing the contracts dist tree
  before/after.

**Risk / dependencies:**
- Highest-risk phase by file count, but mechanically straightforward.
  `git mv` preserves blame; the import-path edits are a global
  search-and-replace; the dep-cruiser rule migration is the only
  hand-written change with non-trivial review surface.
- New-package npm bootstrap: the first release after this lands will
  fail at the `npm publish` step for `@opensip-tools/dashboard` with
  `404 PUT` until a granular npm token is used to seed the package and
  its trusted-publisher entry is configured. This is the documented
  "Bootstrapping a brand-new package" path in `RELEASING.md` and is
  expected, not a regression. Call this out in the PR description so
  whoever cuts the next release runs the bootstrap script.
- Depends on phase 2 if the consolidated `Finding`/`CheckOutput`
  imports are part of the move; otherwise independent. Recommended
  ordering: phase 2 → phase 3 to avoid two rounds of import edits.

---

## Phase 4 — Clean up the dashboard's public surface and internal duplication

**Goal:** Now that the dashboard is a young, separate package, fix the
positional `generateDashboardHtml` signature (so a future tool's data
can be added without a bespoke parameter), collapse the seven
duplicated Code Paths views behind a `defineRankedView` helper, and
replace the cross-tab `panelOrchestratorJs` global handshake with a
small `tabActivators` registry.

These refactors are bundled because they share the same files and
because doing them after the package split means the public surface
of `@opensip-tools/dashboard` v1 is clean from day one.

**Closes findings:** F1, F2, F7. Validates the resolution of F8.

**Files touched (all under the new `@opensip-tools/dashboard` package
unless noted):**
- `packages/dashboard/src/generator.ts` (signature, helper)
- `packages/dashboard/src/code-paths/view-hot.ts`,
  `view-big.ts`, `view-wide.ts`, `view-untested.ts`,
  `view-search.ts` (collapse to `defineRankedView` configs where the
  shape fits; `view-coupling.ts`, `view-sccs.ts` stay bespoke per the
  audit)
- `packages/dashboard/src/code-paths/function-row.ts` (or new
  `view-template.ts` — host the `defineRankedView` helper)
- `packages/dashboard/src/code-paths/views-registry.ts` (register
  declarative configs)
- `packages/dashboard/src/code-paths.ts` (split
  `panelOrchestratorJs`; export `openCodePathsSession` registration)
- `packages/dashboard/src/shared.ts` (declare
  `tabActivators` registry + `activateTabForSession(s)` helper)
- `packages/dashboard/src/overview.ts` (replace
  `typeof openCodePathsSession === 'function'` guard with
  `activateTabForSession(s)`)
- `packages/fitness/engine/src/cli/dashboard.ts` — update call site to
  the new `generateDashboardHtml({ ... })` options-object shape.
- `packages/dashboard/src/index.ts` — re-export the new
  `DashboardInput` type alongside `generateDashboardHtml`.

**Steps:**

*Sub-step A — `generateDashboardHtml` options object (finding #1):*
1. Replace the positional `(sessions, checkCatalog, recipeCatalog,
   graphCatalog, editorProtocol)` signature with a single
   `DashboardInput` interface:
   ```ts
   export interface DashboardInput {
     sessions: StoredSession[];
     checkCatalog?: CheckCatalogEntry[];
     recipeCatalog?: RecipeCatalogEntry[];
     graphCatalog?: GraphCatalog | null;
     editorProtocol?: string | null;
   }
   ```
   (Sketch only — write the actual types in code.)
2. Inside `generator.ts`, factor the two existing serialization
   patterns into one helper:
   `serializeOptionalBlob(id, value, kind: 'json' | 'literal')`. The
   `<script type="application/json">` and `const X = …` cases collapse
   to one switch.
3. Update fitness's `cli/dashboard.ts:152` call site to pass an
   options object.
4. Export `DashboardInput` from `packages/dashboard/src/index.ts` so
   future Tool-shaped data has a typed extension point.

*Sub-step B — `defineRankedView` (finding #2):*
1. Add `defineRankedView({ id, label, help, columns, metric, predicate? })`
   in a new `view-template.ts` (or extend `function-row.ts` if it is
   the natural home). The helper produces the Strategy that
   `views-registry.ts` already expects.
2. Convert `view-hot.ts`, `view-big.ts`, `view-wide.ts`,
   `view-untested.ts` to ~15-line declarative configs. Each becomes
   `defineRankedView({ id, label, help, columns, metric })`. The
   `view-untested.ts` inline `passesFilter` re-implementation (lines
   38–39) collapses into the `predicate` parameter rather than a
   separate inlined check.
3. Leave `view-coupling.ts`, `view-sccs.ts`, and `view-search.ts`
   as-is — the audit calls these out as different shapes that should
   stay bespoke.
4. Run the dashboard tests; the rendered HTML must be byte-identical
   for the four converted views (snapshot the output before and after
   if the existing tests do not cover this).

*Sub-step C — Tab activator registry (finding #7):*
1. In `shared.ts`, declare:
   ```ts
   const tabActivators: Record<string, (sessionId: string) => void> = {};
   export function registerTabActivator(key: string, fn: (s: string) => void): void { ... }
   export function activateTabForSession(s: string): void { ... }
   ```
2. Have `code-paths.ts` register its activator
   (`registerTabActivator('graph', openCodePathsSession)`) at module
   init, exporting `openCodePathsSession` as a normal symbol rather
   than relying on a global.
3. Replace `overview.ts`'s `typeof openCodePathsSession === 'function'`
   guard with `activateTabForSession(s)`. The call site no longer
   knows `'graph'` by name; it asks the registry.
4. Document in a JSDoc comment on `registerTabActivator` that future
   tabs (`fit`, `sim`, etc.) register their activators here.

*Sub-step D — Verify finding #8 (barrel hygiene):*
1. Build `@opensip-tools/contracts` and confirm
   `dist/index.d.ts` no longer mentions any dashboard types beyond
   the `GraphCatalog` shape that intentionally lives in contracts.
2. Confirm `dist/index.js` does not bundle dashboard runtime code.
3. No code change required here unless the build output disagrees;
   if it does, fix the export in `contracts/src/index.ts`.

**Acceptance:**
- `generateDashboardHtml({ ... })` is the only public signature; the
  positional form is gone.
- `defineRankedView` is the only place that knows the rank-and-render
  skeleton; `view-hot.ts`/`view-big.ts`/`view-wide.ts`/`view-untested.ts`
  are each ≤30 lines.
- `overview.ts` does not name `openCodePathsSession` directly; it goes
  through `activateTabForSession`.
- `pnpm test` passes including snapshot/regression tests on the four
  converted views and a smoke test that opens the generated HTML and
  exercises the cross-tab handoff (existing dashboard test fixture is
  fine).
- `pnpm lint` clean — the existing `dashboard-views-disjoint` rule
  still passes (the helper lives in `function-row.ts` /
  `view-template.ts`, not in another `view-*.ts`).
- `dist/index.d.ts` of contracts contains zero dashboard-runtime
  surface (finding #8 verification).

**Risk / dependencies:**
- Behavior parity for the dashboard HTML is the load-bearing
  invariant. Snapshot the rendered output before the refactor and
  diff after; bytes should match for unchanged inputs.
- Depends on phase 3. Cannot start before the package split lands.

---

## Phase 5 — Documentation, deprecation, and policy

**Goal:** Capture the `CliArgs` deprecation as a CHANGELOG / contributor
note (no code change), update any remaining docs the dashboard split
missed, and add a contributor-facing note about the new
`@opensip-tools/dashboard` package and how to extend it.

**Closes findings:** F6 (deprecation policy only). Final cleanup of F8
docs.

**Files touched:**
- `CHANGELOG.md` — add a "Deprecated" entry under the next minor: do
  not extend `CliArgs`; new flags belong on `FitOptions`,
  `ToolOptions`, `InitOptions`, etc.
- `packages/contracts/src/types.ts` — add a JSDoc `@deprecated` tag
  on `CliArgs` referencing the per-command interfaces. Do not delete
  the type — `*OptsToCliArgs` adapters in `fitness`, `simulation`,
  and the CLI's `init` command are doing real work and a rip-out is
  out of scope.
- `docs/architecture/70-surfaces/02-plugin-authoring.md` (or
  equivalent contributor-facing surface doc) — add a "Don't extend
  `CliArgs`" call-out for Tool authors.
- `docs/architecture/70-surfaces/03-dashboard.md` — add a
  "Extending the dashboard" section pointing at
  `defineRankedView`, the `tabActivators` registry, and the
  `DashboardInput` options object as the three contributor-facing
  surfaces.

**Steps:**
1. Add the `@deprecated` JSDoc tag and the CHANGELOG entry.
2. Add a doc section explaining: (a) which interface to extend when,
   (b) why `CliArgs` is the wrong place, (c) the `*OptsToCliArgs`
   adapter pattern as the temporary bridge.
3. Add a doc section on dashboard extensibility for the three new
   seams from phase 4.
4. Skim `docs/` for any remaining "dashboard lives in contracts"
   wording that phase 3 missed.

**Acceptance:**
- `CliArgs` shows a `@deprecated` tag in IDE tooltips.
- A new contributor reading the surface docs is told to extend
  per-command interfaces, not `CliArgs`.
- `pnpm typecheck && pnpm lint` clean (the `@deprecated` tag should
  not cause new lint errors in callers — the adapter pattern uses
  the type intentionally).

**Risk / dependencies:**
- Documentation-only. No runtime change.
- Depends on phases 3 and 4 (the dashboard-extensibility doc section
  references the new APIs).

---

## Deferred

The audit lists a handful of patterns considered and dismissed; this
plan honours those decisions rather than reopening them. Specifically:

- **Class hierarchy for `CommandResult`.** Not done. The discriminated
  union and `App.tsx`'s `switch` over `result.type` are the right
  shape; the audit explicitly rejects classes here.
- **React/Preact in the dashboard.** Not done. The "self-contained
  HTML, no bundler" property is intentional and load-bearing; a
  framework would force a build step. The vanilla-DOM cost (the
  duplication phase 4 fixes mechanically) is the correct trade-off.
- **Chain-of-Responsibility class for `getErrorSuggestion`.** Not
  done. Phase 1's flat `{ match, suggest }` table is the right shape;
  CoR adds ceremony without buying anything.
- **Formal `Renderer` Strategy interface.** Not done. The view
  signature is already a Strategy in everything but name; the
  `defineRankedView` helper in phase 4 captures the variability that
  matters. A formal interface would not improve anything per the
  audit's non-finding section.
- **Subpath export `@opensip-tools/contracts/dashboard`.** Not done.
  The CLAUDE.md guidance discourages subpath exports and the package
  split (phase 3) makes this unnecessary. Finding #8 resolves
  automatically once the split lands; phase 4 sub-step D is the
  verification rather than a separate subpath-export change.
- **`CliArgs` rip-out.** Deferred indefinitely. Phase 5 documents the
  deprecation; the actual removal is a future PR — and only after the
  `*OptsToCliArgs` adapters in fitness/simulation/CLI are migrated to
  accept the focused per-command types directly. This is a slow-burn
  refactor, not a Layer-2 phase.
- **CSP / inline-script hardening of the dashboard.** Audit non-finding;
  the generator already escapes `<` / `>` in serialized JSON via
  `escapeForScriptContext`, and the document is a single local HTML
  file the user opens themselves. CSP is the consumer's choice, not
  a contract concern.
- **Persistence file-format encapsulation.** Audit non-finding;
  `saveSession` and `loadSessions` are already the only path in/out,
  the cap and timestamp filename format are internal, and the
  contract-surfaces doc explicitly says session record format is not
  a contract.
- **Opening `CliOutput.tool` to `string`.** Audit non-finding;
  intentionally a closed enum — adding a tool is a minor-version
  bump, and a `string` here would weaken the JSON-output contract
  for no callsite gain.
