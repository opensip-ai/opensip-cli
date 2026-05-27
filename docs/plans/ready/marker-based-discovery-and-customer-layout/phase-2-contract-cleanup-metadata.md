# Phase 2: Contract cleanup — kill `metadata`

**Goal:** Remove the dead `metadata` field from all plugin export contracts and from every first-party check pack. The data duplicates `package.json`; nothing consumes it; future consumers (if any) get a fresh design.

**Depends on:** —

---

## Task 2.1: Remove `metadata` from plugin export contracts

**Files:** [size: S]
- Modify: `packages/core/src/plugins/types.ts`
- Modify: `packages/fitness/engine/src/plugins/types.ts`
- Modify: `packages/simulation/engine/src/plugins/types.ts`

**Context:** Three sibling contracts each carry `metadata?: PluginMetadata`:
- `packages/core/src/plugins/types.ts:28-32` — `LangPluginExports`
- `packages/fitness/engine/src/plugins/types.ts:15-25` — `FitPluginExports` (line 18 is the field)
- `packages/simulation/engine/src/plugins/types.ts` — `SimPluginExports` (line ~24)

`PluginMetadata` itself is defined in `packages/core/src/plugins/types.ts:42-48`. A repo-wide grep for actual consumer reads (`mod.metadata`, `exports.metadata`, `plugin.metadata`, `fit.metadata`, `sim.metadata`) returns zero results. All fields (`name`, `version`, `author`, `description`, `homepage`) duplicate `package.json`. The contract slot is dead.

**Steps:**

1. In `packages/core/src/plugins/types.ts`:
   - Remove the `metadata?: PluginMetadata` field from `LangPluginExports`.
   - Remove the `PluginMetadata` interface (lines 42-48).
   - Remove any `PluginMetadata` re-export from `packages/core/src/plugins/index.ts` and `packages/core/src/index.ts`.

2. In `packages/fitness/engine/src/plugins/types.ts`:
   - Remove the `metadata?: PluginMetadata` field from `FitPluginExports`.
   - Remove the `import type { ..., PluginMetadata } from '@opensip-tools/core'` for that symbol.

3. In `packages/simulation/engine/src/plugins/types.ts`:
   - Same removal as fit.

**Wiring:** None — purely subtractive.

**Verification:**
```bash
pnpm --filter=@opensip-tools/core build
pnpm --filter=@opensip-tools/fitness build
pnpm --filter=@opensip-tools/simulation build
pnpm typecheck
```

The typecheck flushes out every site that imported `PluginMetadata` — those become compile errors and get fixed in Tasks 2.2 and 2.3.

**Commit:** `refactor(plugins): remove dead metadata field from export contracts`

---

## Task 2.2: Remove `export const metadata` from every first-party check pack

**Files:** [size: M]
- Modify: `packages/fitness/checks-typescript/src/index.ts`
- Modify: `packages/fitness/checks-universal/src/index.ts`
- Modify: `packages/fitness/checks-python/src/index.ts`
- Modify: `packages/fitness/checks-go/src/index.ts`
- Modify: `packages/fitness/checks-java/src/index.ts`
- Modify: `packages/fitness/checks-cpp/src/index.ts`
- Modify: `packages/fitness/checks-rust/src/index.ts`

**Context:** Each pack has an identical-shape block (e.g. `packages/fitness/checks-typescript/src/index.ts:30-35`):

```ts
/** Plugin metadata */
export const metadata = {
  name: '@opensip-tools/checks-typescript',
  version: readPackageVersion(import.meta.url),
  description: 'TypeScript/Node.js fitness checks for opensip-tools',
}
```

`readPackageVersion` is a helper that reads `package.json` at runtime. With `metadata` removed, the `readPackageVersion` import may also become unused — clean both up.

**Steps:**

For each of the seven files:

1. Delete the `export const metadata = {...}` block.
2. Remove the docstring comment immediately above it (`/** Plugin metadata */` or similar).
3. If `readPackageVersion` (or whatever the version-reading helper is) is no longer used in the file, remove that import too. (Grep within the file before removing.)
4. Update the file-header docstring if it explicitly mentions "exports `metadata`" — adjust to list only what's left (`checks`, `checkDisplay`).

**Wiring:** None.

**Verification:**
```bash
pnpm --filter=@opensip-tools/checks-typescript build
pnpm --filter=@opensip-tools/checks-universal build
pnpm --filter=@opensip-tools/checks-python build
pnpm --filter=@opensip-tools/checks-go build
pnpm --filter=@opensip-tools/checks-java build
pnpm --filter=@opensip-tools/checks-cpp build
pnpm --filter=@opensip-tools/checks-rust build
pnpm typecheck
pnpm test
```

**Commit:** `refactor(checks): remove dead metadata export from first-party packs`

---

## Task 2.3: Fix any straggler imports of `PluginMetadata`

**Files:** [size: XS, exploratory]
- Modify: (any file flagged by Task 2.1's typecheck)

**Context:** Task 2.1's typecheck across the workspace will produce TS2305 errors at every site that imports `PluginMetadata`. This task fixes those sites. Likely candidates:
- Test files that imported the type for fixture builders
- Doc-generation tooling
- `cli-ui` or other peripheral packages that may have referenced the type

Most likely there are none — the grep in Task 2.1's context shows no consumer reads. But typecheck is the source of truth.

**Steps:**

1. Run `pnpm typecheck` and collect TS2305 errors mentioning `PluginMetadata`.
2. For each: remove the import. If the imported symbol was used (e.g. in a test fixture), inline the relevant fields literally or remove the test if it's solely about metadata round-tripping.

**Wiring:** None.

**Verification:**
```bash
pnpm typecheck
pnpm test
pnpm lint
```

**Commit:** `refactor(*): drop stale PluginMetadata imports after contract removal` (or skip the commit if no fixes were needed)

---

## Phase 2 End-to-End Verification

- `pnpm typecheck` clean across all packages.
- `pnpm test` green (any test that specifically asserted on `metadata` export should be removed or rewritten to assert on `package.json` instead — that's the canonical source).
- `pnpm lint` — 0 errors.
- Grep: `git grep "export const metadata" packages/fitness/checks-*` returns nothing.
- Grep: `git grep "PluginMetadata" packages/` returns nothing.

> **Deferred:** Customer-facing release-notes copy — the change is non-breaking at the runtime level (no consumer was reading the export) but is observable in `git diff`. Note in the release notes that the field is gone and packs SHOULD remove their export; the marker walker doesn't care about its presence or absence.
