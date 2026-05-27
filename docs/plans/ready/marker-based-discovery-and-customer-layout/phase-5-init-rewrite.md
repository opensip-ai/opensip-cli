# Phase 5: Init rewrite

**Goal:** Replace `init`'s loose-`.mjs`-files scaffold with a full per-domain workspace-package skeleton (`opensip-tools/fit/` and `opensip-tools/sim/` each become real `@<scope>/fit` / `@<scope>/sim` packages with `package.json`, `tsconfig.json`, `vitest.config.ts`, `index.ts`, example check/scenario, example recipe, README). Update workspace globs at the repo root. Revise the state classifier.

**Depends on:** Phase 2 (so init doesn't scaffold the killed `metadata` field).

---

## Task 5.1: Add per-domain template emitters

**Files:** [size: M]
- Create: `packages/cli/src/commands/init/pack-templates/package-json.ts`
- Create: `packages/cli/src/commands/init/pack-templates/tsconfig-json.ts`
- Create: `packages/cli/src/commands/init/pack-templates/vitest-config.ts`
- Create: `packages/cli/src/commands/init/pack-templates/index-ts.ts`
- Create: `packages/cli/src/commands/init/pack-templates/example-check.ts` (template for fit's example)
- Create: `packages/cli/src/commands/init/pack-templates/example-scenario.ts` (template for sim's example)
- Create: `packages/cli/src/commands/init/pack-templates/example-recipe.ts` (template, used by both domains)
- Create: `packages/cli/src/commands/init/pack-templates/readme-md.ts`

**Context:** Today `init.ts` has inline template functions like `exampleCheckSource(lang)` (line 286), `exampleRecipeSource()` (line 324), `exampleScenarioSource()` (line 346), `exampleSimRecipeSource()` (line 369). Each returns a string of file contents. The pattern works but doesn't extend cleanly to a full package-skeleton scaffold (8 file kinds × 2 domains).

This task introduces a `pack-templates/` directory with one module per file kind. Each module exports a function `emit(opts) → string` where `opts` carries domain (`'fit' | 'sim'`), language (where relevant), and the customer's scope placeholder. The functions are pure — no side effects.

**Steps:**

1. Each template module exports a single function. The signatures, summarized:
   - `package-json.ts`: `emitPackageJson({ domain, scopePlaceholder, fitnessVersion }): string` — produces JSON with `"name": "${scopePlaceholder}/${domain}"`, `"private": true`, `"type": "module"`, `"opensipTools": { "kind": "${domain}-pack" }`, `"main": "./dist/index.js"`, scripts (`build`, `test`, `typecheck`), `devDependencies` listing `@opensip-tools/fitness` (or `simulation`) and `@opensip-tools/core`.
   - `tsconfig-json.ts`: `emitTsconfig(): string` — extends a common base (`@opensip-tools/tsconfig` if it exists, else a minimal inline config). Compiles to `dist/`.
   - `vitest-config.ts`: `emitVitestConfig(): string` — minimal Vitest config matching the existing convention.
   - `index-ts.ts`: `emitIndexTs({ domain }): string` — re-exports `checks` (fit) or `scenarios` (sim) and `recipes` from the example files. **Does not export `metadata`** (the field is killed in Phase 2).
   - `example-check.ts`: `emitExampleCheck({ language }): string` — a TypeScript example check using `defineCheck` from `@opensip-tools/fitness`. The `.ts` shift (from `.mjs`) is because the directory is now a TS package; the existing inline `exampleCheckSource(lang)` template at `init.ts:286-323` is the basis. Adjust imports to use the package name (which resolves via workspace symlink).
   - `example-scenario.ts`: parallel for sim. Uses `defineLoadScenario` from `@opensip-tools/simulation`.
   - `example-recipe.ts`: `emitExampleRecipe({ domain }): string` — a TypeScript example recipe using `defineRecipe` (fit) or `defineSimulationRecipe` (sim).
   - `readme-md.ts`: `emitReadme({ domain }): string` — short markdown explaining what the pack is, how to add checks/scenarios/recipes, and where to run `pnpm test`.

2. Templates are pure string-returning functions. No filesystem access — that's the caller's job (Task 5.2). No template-engine — string interpolation is fine for content this small.

3. Inputs that need decisions baked in now:
   - **Scope placeholder**: use a literal placeholder like `@your-scope` in the generated `package.json` `name` field. A trailing comment instructs the customer to rename. (Alternatives considered: auto-detect from existing root `package.json#name`'s scope; require an `--scope` flag. Both add complexity; the placeholder is simplest and customer-correctable in 5 seconds.)
   - **opensip-tools dependency version**: read from the CLI's own `package.json` so init scaffolds an exact-pin or caret-pin matching the version that scaffolded it. Use `^X.Y.Z` (caret) by default.
   - **TypeScript version**: target the version range already used by `@opensip-tools/cli`'s `package.json`.

4. Each template module gets a unit test file (`__tests__/<template>.test.ts`) verifying the emitted string parses (JSON for the json ones; TypeScript via a light syntax check or just a snapshot) — scaffold the test files here; Phase 7 fills in real assertions.

**Wiring:** Called from `scaffold-pack-skeleton.ts` (Task 5.2).

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli build
pnpm --filter=@opensip-tools/cli typecheck
pnpm --filter=@opensip-tools/cli test
```

**Commit:** `feat(cli): per-domain pack-skeleton template emitters`

---

## Task 5.2: Add `scaffold-pack-skeleton` orchestrator

**Files:** [size: M]
- Create: `packages/cli/src/commands/init/scaffold-pack-skeleton.ts`

**Context:** A single orchestrator that takes a domain (`'fit' | 'sim'`), the resolved project paths, the detected language, and a force flag — and writes the full set of files for that domain via the templates from Task 5.1. Returns a list of `{ path, contents }` for the caller to commit / log / verify.

**Steps:**

1. Function signature:
   ```typescript
   export interface ScaffoldedFile {
     readonly path: string;        // absolute path
     readonly contents: string;
   }

   export function scaffoldPackSkeleton(opts: {
     readonly domain: 'fit' | 'sim';
     readonly paths: ProjectPaths;
     readonly language: SupportedLanguage;
     readonly scopePlaceholder: string;  // e.g. '@your-scope'
     readonly fitnessVersion: string;
   }): readonly ScaffoldedFile[];
   ```

2. Implementation builds the file list:
   - `<userSourceDir>/<domain>/package.json` ← `emitPackageJson({...})`
   - `<userSourceDir>/<domain>/tsconfig.json` ← `emitTsconfig()`
   - `<userSourceDir>/<domain>/vitest.config.ts` ← `emitVitestConfig()`
   - `<userSourceDir>/<domain>/index.ts` ← `emitIndexTs({ domain })`
   - `<userSourceDir>/<domain>/<checks-or-scenarios>/example-<check-or-scenario>.ts` ← `emitExampleCheck` / `emitExampleScenario`
   - `<userSourceDir>/<domain>/recipes/example-recipe.ts` ← `emitExampleRecipe({ domain })`
   - `<userSourceDir>/<domain>/README.md` ← `emitReadme({ domain })`

3. Writes are *not* performed here — the function returns the descriptors; the caller (Task 5.4) does the I/O. This keeps testing simple.

**Wiring:** Called by the updated `runScaffold` (Task 5.4).

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli build
pnpm --filter=@opensip-tools/cli test
```

**Commit:** `feat(cli): scaffoldPackSkeleton orchestrator`

---

## Task 5.3: Add workspace-globs updater

**Files:** [size: S]
- Create: `packages/cli/src/commands/init/ensure-workspace-globs.ts`

**Context:** For the customer's workspace to symlink `opensip-tools/fit/` and `opensip-tools/sim/` into `node_modules/`, their `pnpm-workspace.yaml` (or `package.json#workspaces`) needs to include `opensip-tools/*`. Today init doesn't touch workspace config — customers must add the glob themselves. After this task, init ensures the glob exists.

Three sub-cases:
1. **`pnpm-workspace.yaml` exists** — read it, parse YAML, append `opensip-tools/*` to the `packages` array if not already present. Write back.
2. **`package.json#workspaces` exists** (npm/yarn convention, or a non-pnpm pnpm fallback) — read, append, write.
3. **Neither exists** — create `pnpm-workspace.yaml` with `packages: ['opensip-tools/*']`. (Heuristic: if a `pnpm-lock.yaml` exists in the repo root, prefer creating `pnpm-workspace.yaml`. Otherwise, default to `package.json#workspaces`.)

The function is idempotent — running it twice is a no-op.

**Steps:**

1. Function signature:
   ```typescript
   export function ensureWorkspaceGlobs(projectDir: string): {
     readonly modified: boolean;
     readonly file: string;   // absolute path of the file modified/created
     readonly action: 'created' | 'appended' | 'unchanged';
   };
   ```

2. Implementation handles the three sub-cases above with explicit file checks and append logic. Uses `yaml` package (already a workspace dep — verify) for `pnpm-workspace.yaml` parsing.

3. The function does not touch the customer's existing entries — only appends `'opensip-tools/*'` to the end of the `packages` array (or `workspaces` array) if not present.

**Wiring:** Called by `runScaffold` (Task 5.4) immediately after `scaffoldPackSkeleton`.

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli build
pnpm --filter=@opensip-tools/cli test
```

**Commit:** `feat(cli): ensureWorkspaceGlobs helper`

---

## Task 5.4: Update `executeInit` / `runScaffold` to use the new skeleton

**Files:** [size: M]
- Modify: `packages/cli/src/commands/init.ts`

**Context:** Today `runScaffold` at line 827 writes the four loose-`.mjs` files inline. This task replaces that with calls to `scaffoldPackSkeleton` (per domain) and `ensureWorkspaceGlobs`.

The state classifier (`classifyWorkingDir` at line 479) also needs an update: it currently checks for "is `opensip-tools/` present and does it contain `fit/` or `sim/`?" — that question stays valid, but the answer's meaning shifts. A `fit/` directory containing only loose `.mjs` files is one shape; a `fit/` directory containing `package.json` + `index.ts` is another. The classifier doesn't need to distinguish — it just needs to know "is this directory non-empty?" — but the **messaging** around `--keep` and `--remove` should reflect the new shape (e.g. `--keep` re-scaffolds package skeleton files if missing, preserves user-authored checks/recipes; `--remove` deletes the whole subtree).

**Steps:**

1. In `runScaffold`, replace the four inline writes (`exampleCheckSource`, `exampleRecipeSource`, `exampleScenarioSource`, `exampleSimRecipeSource`) with two calls:
   ```typescript
   const fitFiles = scaffoldPackSkeleton({ domain: 'fit', paths, language, scopePlaceholder, fitnessVersion });
   const simFiles = scaffoldPackSkeleton({ domain: 'sim', paths, language, scopePlaceholder, fitnessVersion });
   // Write each file from fitFiles and simFiles (mkdirSync parent, writeFileSync contents)
   ```

2. After the writes, call `ensureWorkspaceGlobs(projectDir)` and log the action (created / appended / unchanged) in the init output.

3. Update the existing `.gitignore` append logic (currently adds `opensip-tools/.runtime/`) to also append `opensip-tools/fit/dist/` and `opensip-tools/sim/dist/` (build output is gitignored too).

4. Update the file-header docstring (line 1-44) to reflect the new scaffold output.

5. Update the `classifyWorkingDir` function's docstring to note that `fit/` and `sim/` are now workspace package roots, but the classifier's logic doesn't change.

6. Update the `--keep` semantics: when re-scaffolding, only write skeleton files (`package.json`, `tsconfig.json`, `vitest.config.ts`, `index.ts`, `README.md`) if they're missing; leave existing example checks/recipes untouched. (Today `--keep` re-scaffolds examples regardless — the new semantics are more conservative because skeleton files are heavier-touch.)

7. Remove the obsolete inline template functions (`exampleCheckSource`, `exampleRecipeSource`, `exampleScenarioSource`, `exampleSimRecipeSource`) — they're replaced by the per-template modules. Update any other code that referenced them.

8. The `buildScaffoldTemplates` function (mentioned in the existing init.ts header at line 532) which builds the full set of templates for stale-scaffolded detection: update it to reference the new template emitters so SHA-256 content-match still works.

**Wiring:** `executeInit` (line 878) calls `runScaffold`; nothing upstream changes.

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli build
pnpm --filter=@opensip-tools/cli typecheck
pnpm --filter=@opensip-tools/cli test
```

Existing init integration tests (`packages/cli/src/commands/__tests__/init.test.ts` and friends) will fail because the scaffolded file list changed. Update them in Phase 7.

**Commit:** `feat(cli): init scaffolds full per-domain pack skeleton`

---

## Phase 5 End-to-End Verification

- `pnpm --filter=@opensip-tools/cli test` — many init tests need updating in Phase 7; expected red until Phase 7 lands. Mark which tests fail and confirm the failures are scaffold-shape changes, not logic errors.
- `pnpm typecheck` — green.
- `pnpm lint` — 0 errors.
- Manual smoke (deferred to Phase 8):
  1. `mkdir /tmp/test-init && cd /tmp/test-init && pnpm init -y`
  2. Run `<path-to-cli>/bin/opensip-tools init`
  3. Verify `opensip-tools/fit/` contains `package.json` (with marker), `tsconfig.json`, `vitest.config.ts`, `index.ts`, `checks/example-check.ts`, `recipes/example-recipe.ts`, `README.md`.
  4. Verify same for `opensip-tools/sim/`.
  5. Verify `pnpm-workspace.yaml` exists (or was updated) with `opensip-tools/*` entry.
  6. `pnpm install` succeeds.
  7. `<path-to-cli>/bin/opensip-tools fit` finds the example check via marker discovery and runs it.

> **Deferred:** Customer-facing copy review — every new scaffolded file is read by every new opensip-tools customer. The README templates, `package.json` `description` placeholder, init's success message, and the `--keep` semantics shift all need a human copy review before merge.
