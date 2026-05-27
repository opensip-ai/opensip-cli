# Phase 5: Thread `RunScope` through `ToolCliContext`

**Goal:** Add `scope: RunScope` to `ToolCliContext`; construct the scope in `packages/cli/src/index.ts`'s bootstrap; delete the module-level `currentProjectContext` and `datastoreCache` holders in `cli/src/cli-context.ts`; migrate every `cli.datastore` / `cli.project` access to read from `cli.scope` instead (transparently — the existing getter shape is preserved).

**Depends on:** Phase 3 (tool registries migrated) + Phase 4 (`RunScope` exists).

This is the second-most invasive phase, second only to Phase 6 (side-effect elimination). It changes the CLI's central dispatch contract. Each task is independent enough to land as its own commit on the PR.

---

## Task 5.1: Add `scope` to `ToolCliContext`

**Files:**
- Modify: `packages/core/src/tools/types.ts` (the `ToolCliContext` interface)
- Modify: `packages/contracts/src/cli-context.ts` if a contracts-side declaration exists

**Context:** `ToolCliContext` is the dispatch contract between the CLI and each tool. Adding `scope: RunScope` is non-breaking because no tool reads it yet — Phase 5 introduces the field and the CLI populates it; Tasks 5.2 / 5.3 migrate consumers in the same PR.

**Steps:**

1. Add `readonly scope: RunScope` to `ToolCliContext`:

   ```typescript
   import type { RunScope } from '../lib/run-scope.js';

   export interface ToolCliContext {
     readonly program: unknown;
     readonly project: ProjectContext;
     readonly scope: RunScope;             // ← new field
     readonly render: (result: unknown) => Promise<void>;
     // … existing fields unchanged
   }
   ```

2. Update the JSDoc to point new contributors at RunScope: "Per-run resources (logger, caches, registries, datastore) live on `scope`. Tools should prefer `cli.scope.foo` over reaching into any module-level singleton."

3. Compile check: this addition will break every `buildToolCliContext` call site (there's exactly one — `cli/src/cli-context.ts`) because the returned `ctx` no longer satisfies the interface. Task 5.2 fixes the constructor.

**Observability:** None.

**Wiring:** Contract surface gains one field.

**Error cases:** None.

**Verification:**
```bash
pnpm --filter @opensip-tools/core build
# Expected: downstream packages now fail to compile until 5.2 + 5.3 land.
```

**Commit:** `feat(core): add scope: RunScope to ToolCliContext`

---

## Task 5.2: Construct `RunScope` in the CLI bootstrap

**Files:**
- Modify: `packages/cli/src/cli-context.ts`
- Modify: `packages/cli/src/index.ts` (or wherever `buildToolCliContext` is called from)
- Modify: `packages/cli/src/bootstrap/pre-action-hook.ts` (this is where `setProjectContextForRun` is currently invoked)

**Context:** The current `cli-context.ts:49-50` keeps `let currentProjectContext` and `let datastoreCache` at module scope, mutated by `setProjectContextForRun`. With RunScope owning that state, the pre-action hook constructs a scope and passes it forward.

**Steps:**

1. In `cli/src/cli-context.ts`:
   - Delete the two `let` declarations at lines 49-50.
   - Delete `setProjectContextForRun` (callers will pass the scope instead).
   - Delete `getCurrentProjectRoot` — its callers (`maybeOpenDashboard`, etc.) should receive the scope explicitly. If that's too disruptive in this PR, keep a thin shim that reads `currentScope()?.projectContext?.projectRoot` and throws if absent, with a `@deprecated` tag.
   - Modify `buildToolCliContext` to accept `scope: RunScope` and stash it on the returned `ctx`. The `project` getter reads `scope.projectContext`; the `datastore` getter reads `scope.datastore()`.

2. In `cli/src/bootstrap/pre-action-hook.ts`:
   - Resolve `ProjectContext` as today.
   - Construct `scope = new RunScope({ logger, projectContext, datastore: () => getOrOpenDatastore(...) })`.
   - Pass `scope` to `buildToolCliContext(...)`.
   - Wrap the rest of the command's execution in `await runWithScope(scope, async () => { ... })` so any `currentScope()` call inside the command sees this scope.

3. Update `cli/src/index.ts` to thread `scope` into the bootstrap. The flow becomes:

   ```typescript
   program.hook('preAction', async (cmd) => {
     const projectContext = await resolveProjectContext(cmd);
     const scope = new RunScope({
       logger,
       projectContext,
       datastore: () => getOrOpenDatastore(logger),
     });
     const handle = buildToolCliContext({ ...opts, scope });
     // Stash the handle on a command-level context so commands' action() can
     // call into it inside a runWithScope wrapper.
   });
   ```

**Observability:** No new events. The `cli.datastore.opened` event (currently at `cli-context.ts:94`) keeps firing — `getOrOpenDatastore` is now invoked via the thunk, but the emit is unchanged.

**Wiring:** Every code path that previously called `setProjectContextForRun(...)` now constructs the scope at that point.

**Error cases:** If `scope.datastore()` is called outside a project context, `getOrOpenDatastore` throws as today. The error message stays the same.

**Verification:**
```bash
pnpm --filter @opensip-tools/cli build
pnpm --filter @opensip-tools/cli test
```

**Commit:** `refactor(cli): RunScope replaces module-level cli-context holders`

---

## Task 5.3: Migrate every tool's `register(cli)` to use `cli.scope`

**Files:**
- Modify: `packages/fitness/engine/src/tool.ts`
- Modify: `packages/simulation/engine/src/tool.ts`
- Modify: `packages/graph/engine/src/tool.ts`

**Context:** Each tool's `register(cli)` body currently does things like:
- `cli.datastore as DataStore` — five casts in fitness, three in graph (per the cross-cutting T3 finding)
- accesses `cli.project.projectRoot` for path resolution
- (probably) reaches module globals like `defaultToolRegistry` indirectly via shared utilities

This task migrates them to `cli.scope.datastore() as DataStore`, `cli.scope.projectContext.projectRoot`, etc. The casts themselves stay (T3 is a separate effort); only the *source* of the value changes.

**Steps:**

1. For each tool's `tool.ts`, grep for `cli\.(datastore|project)` and replace with `cli.scope.datastore()` / `cli.scope.projectContext`. The casts to `DataStore` and the `as` assertions stay.

2. Tools that reach into `defaultToolRegistry` (e.g. for `program.hook` semantics) read `cli.scope.tools` instead.

3. Tools that previously called `getCurrentProjectRoot()` (if any) now access `cli.scope.projectContext.projectRoot` directly.

4. No change to the tool's public API. The migration is internal to each `tool.ts`.

**Observability:** No new events.

**Wiring:** Each tool's `register(cli)` reads through `cli.scope` instead of module globals.

**Error cases:** Same as before — `cli.scope.projectContext` is undefined in non-project contexts, and tools that require a project context already handle that case.

**Verification:**
```bash
pnpm test
pnpm fit                                  # dogfood
grep -rn "cli\.datastore" packages/        # only fitness/simulation/graph; should narrow over time
grep -rn "currentProjectContext\|datastoreCache" packages/  # zero matches outside cli-context.ts
```

**Commit:** `refactor(fitness,simulation,graph): tools read state via cli.scope`

---

## Task 5.4: Remove `defaultToolRegistry` / `defaultLanguageRegistry` shims

**Files:**
- Modify: `packages/core/src/tools/registry.ts`
- Modify: `packages/core/src/languages/registry.ts`
- Modify: `packages/core/src/index.ts`
- Modify: every consumer of those defaults

**Context:** Per the Phase 4 note, the default singletons survive as back-compat shims. With Tasks 5.1 / 5.2 / 5.3 landed, every consumer reads through `cli.scope.tools` / `cli.scope.languages`. The defaults can go.

**Steps:**

1. `grep -rn "defaultToolRegistry\|defaultLanguageRegistry" packages/`. List every consumer.
2. For each: change to `cli.scope.tools` / `cli.scope.languages` if inside a tool, or to a passed-in scope if it's a library function.
3. Delete the `defaultToolRegistry` and `defaultLanguageRegistry` exports from `core/src/tools/registry.ts` and `core/src/languages/registry.ts`.
4. Remove their re-exports from the core barrel.

**Observability:** None.

**Wiring:** The module-level "default registry" pattern is gone. Every consumer takes a scope.

**Error cases:** If a consumer was relying on the default for an early-load registration (e.g. `defaultToolRegistry.register(fitnessTool)` at module load), that registration must move into the bootstrap path where the scope is constructed. Phase 0 Task 0.1's grep enumerated these — review the list before deletion.

**Verification:**
```bash
grep -rn "defaultToolRegistry\|defaultLanguageRegistry" packages/   # zero matches
pnpm typecheck && pnpm test && pnpm lint
```

**Commit:** `refactor(core): remove defaultToolRegistry / defaultLanguageRegistry module-level shims`

---

## End-of-phase verification

```bash
pnpm typecheck && pnpm test && pnpm lint
pnpm fit
grep -rn "currentProjectContext\|datastoreCache\|defaultToolRegistry\|defaultLanguageRegistry" packages/  # zero matches
```

Acceptance:

- [ ] `ToolCliContext.scope: RunScope` is the canonical access point for per-run state.
- [ ] `cli-context.ts` has no module-level mutable state.
- [ ] `setProjectContextForRun` is deleted. `getCurrentProjectRoot` either deleted or a `@deprecated` shim.
- [ ] Every tool's `register(cli)` reads through `cli.scope.*` for state.
- [ ] `defaultToolRegistry` / `defaultLanguageRegistry` removed from core exports.
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm lint` green. `pnpm fit` dogfood gate green.
- [ ] CLI e2e tests still pass — the migration is invisible to end users.
