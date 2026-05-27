# Phase 6: Docs

**Goal:** Rewrite the customer-facing plugin authoring doc to lead with the marker pattern and the directory-IS-the-package layout. Soft-deprecate `packageScopes` as a compat mechanism. Update the CLI command-tree doc for init's new scaffold output.

**Depends on:** Phases 3, 4, 5 (so docs describe the actual shipped behavior).

---

## Task 6.1: Rewrite section 4 of `02-plugin-authoring.md`

**Files:** [size: M]
- Modify: `docs/architecture/70-surfaces/02-plugin-authoring.md`

**Context:** Section 4 ("A check pack (publishable)") was last revised in FU-2-revision to recommend `opensip-tools/packages/<name>/`. With Phase 5 shipped, the recommended layout is `opensip-tools/<domain>/` IS the package. Section 4 needs a substantial rewrite to reflect that and to introduce the marker pattern.

Also: the "Three paths" enumeration (current state from FU-2) becomes "Four paths" with the marker addition. `packageScopes` shifts from "scope-wide auto-discovery, recommended for monorepos" to "compat for legacy third-party packs."

**Steps:**

1. Rewrite section 4's opening paragraph to describe the directory-IS-the-package model. Show the canonical scaffolded shape (what `init` produces).

2. Rewrite the "Where should this package live in your repo?" subsection:
   - Recommended: `opensip-tools/<domain>/` (the directory IS the package).
   - Mention the workspace-globs entry (`opensip-tools/*` in `pnpm-workspace.yaml`) and that `init` writes/updates it.
   - Drop the prior recommendation of `opensip-tools/packages/<name>/`.

3. Rewrite "Naming and auto-discovery":
   - Lead with the marker pattern (`opensipTools.kind: "fit-pack"` or `"sim-pack"` in the pack's `package.json`).
   - Show the canonical `package.json` shape.
   - Note: package can use any scope — `@your-co/fit`, `@anything/anything`, doesn't matter; the marker is what makes discovery work.

4. Replace the "Three paths" enumeration with **Four paths** (`<a id="discovery-four-paths"></a>`):
   - **Marker (recommended)** — `opensipTools.kind: "fit-pack"` in `package.json`. Free choice of scope. Auto-discovered by the marker walker.
   - **`@opensip-tools/checks-*` name pattern** — auto-discovered by the default scope scan. Reserved for first-party packs published by the opensip-tools project. Don't publish under this scope.
   - **`plugins.packageScopes` (compat)** — soft-deprecated. Useful for legacy third-party packs that follow `@scope/checks-*` naming without declaring the marker. New packs should use the marker pattern.
   - **`plugins.checkPackages` explicit listing** — pin individual packages by name. Useful for deterministic, version-pinned builds. `opensip-tools plugin add @scope/pack` does this in one step.

5. Update the "Reference example" section: point at the canonical layout produced by `init`. Drop or update any external repo reference if stale.

6. Add a "Sim packs" subsection mirroring the check-pack pattern — `opensip-tools/sim/` IS the package, marker is `sim-pack`, etc.

7. Update the top of section 4 to note the contract change: `metadata` is no longer part of `FitPluginExports` / `SimPluginExports`. If you copy-pasted an old example with `export const metadata`, delete that block.

**Wiring:** Doc-only; consumed by humans + the `docs/web/` build mirror.

**Verification:**
```bash
pnpm docs:build  # regenerates docs/web/ mirror — pre-commit hook will fail otherwise
```

Then visually skim the rendered doc for flow.

**Commit:** `docs(plugin-authoring): marker-based discovery + new directory-is-the-package model`

---

## Task 6.2: Update CLI command-tree doc for init's new scaffold output

**Files:** [size: S]
- Modify: `docs/architecture/70-surfaces/01-cli-command-tree.md`

**Context:** The init section of the CLI command-tree doc describes what files init creates and the state machine it enforces. Both need updating for the new scaffold output.

**Steps:**

1. Update the init scaffold-output list to reflect Phase 5's full skeleton (per-domain `package.json`, `tsconfig.json`, `vitest.config.ts`, `index.ts`, example check/scenario, example recipe, README, plus the workspace-globs entry).

2. If the state-table for `pristine` / `partial-config-only` / `partial-dir-only` / `fully-initialized` is in this doc, update the row descriptions to mention that `fit/` and `sim/` are now workspace package roots.

3. Update the `--keep` / `--remove` semantics description to match Phase 5.4 step 6 (keep is more conservative: skeleton files only re-scaffolded if missing; examples preserved).

**Wiring:** Doc-only.

**Verification:**
```bash
pnpm docs:build
```

**Commit:** `docs(cli): init's new pack-skeleton scaffold output`

---

## Task 6.3: Add a release note for `packageScopes` soft-deprecation

**Files:** [size: XS]
- Modify: `CHANGELOG.md` (or equivalent — confirm naming during implementation)

**Context:** The `packageScopes` config key is moving from "recommended for monorepo customer scopes" (FU-3's framing) to "compat shim for legacy third-party packs." Code unchanged. Release notes should mention the shift so consumers re-read the doc and understand the marker pattern is the new path.

**Steps:**

1. Add a CHANGELOG entry under the next version's "Changed" section: one paragraph explaining the framing shift, with a link to section 4 of plugin-authoring.md.

2. Mention the killed `metadata` export (Phase 2) under "Removed" with a one-line note that consumers were not reading it; first-party packs have been updated.

3. Mention the new `recipesRegistered` field on `cli.check_package.loaded` (Phase 3) under "Changed" so consumers parsing log events know.

4. Mention the warning shift in sim's recipe loading (Phase 4) — packs with malformed recipes will now see warnings instead of silent drops.

**Wiring:** None.

**Verification:** None beyond `pnpm docs:build` if CHANGELOG is in the docs mirror.

**Commit:** `docs(changelog): note marker pattern, packageScopes soft-deprecation, metadata removal`

---

## Phase 6 End-to-End Verification

- `pnpm docs:build` succeeds; the regenerated `docs/web/` mirror reflects all three doc edits.
- Skim the rendered `02-plugin-authoring.md` for flow.
- `pnpm lint` — 0 errors. (No code changes in this phase.)

> **Deferred:** Customer-facing copy review — section 4 of plugin-authoring.md is the most-read doc by new customers. Human review pass required before merge to catch tone / clarity issues.
