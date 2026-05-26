# Phase 1: Contract + bootstrap

**Goal:** Make `ProjectContext` part of the tool contract (`ToolCliContext.project`) AND make the side-effect setup (datastore open, log file creation) genuinely lazy — happening only when an action actually needs them and only after schema checks have decided the run will proceed. After this phase, dry-runs, schema-too-new errors, and "no project found" errors no longer create `.runtime/` as a side effect.
**Depends on:** Phase 0

**Critical design principle for this phase: side effects follow intent.** A previous draft of this phase opened the SQLite datastore unconditionally inside `pre-action-hook`, and `openSqliteBackend` calls `mkdirSync(dirname(opts.path), { recursive: true })` (`packages/datastore/src/backends/sqlite.ts:8`) — which created `.runtime/` on every invocation including dry-runs, schema-too-new bailouts, and "no project found" error paths. The reviewer correctly identified this as undermining the whole "no surprise side effects" goal. This phase fixes it by routing the datastore (and the log-file backing) through getters that fire on first access, with both deferred until *after* all bailout checks.

---

## Task 1.1: Add `project: ProjectContext` to `ToolCliContext`

**Files:** [size: S]
- Modify: `packages/core/src/tools/types.ts`

**Context:** `ToolCliContext` (`packages/core/src/tools/types.ts:98`) is the tool contract. Today it carries `program`, `render`, `registerLiveView`, `renderLive`, `maybeOpenDashboard`, `logger`, `setExitCode`, `emitJson`, `datastore`. The missing field is "the project this CLI invocation is operating on."

Adding `project: ProjectContext` is a non-backwards-compatible change (any tool that constructs a `ToolCliContext` literal will fail typecheck until it provides the field). That's by design — the typecheck is the enforcement that tools can't accidentally bypass discovery.

There's an ergonomic cleanup to do at the same time: `maybeOpenDashboard` (lines 135–139) currently takes a `cwd: string` in its opts block. That field becomes redundant once `ctx.project.projectRoot` exists. Drop it.

**Steps:**

1. Add the import at the top of `types.ts`:

   ```ts
   import type { ProjectContext } from '../lib/project-context.js';
   ```

2. Add the field to the `ToolCliContext` interface (immediately under `readonly program: unknown;`):

   ```ts
   /**
    * Resolved project context for this CLI invocation. Computed once in
    * pre-action-hook after `--cwd` parsing; threaded into every tool's
    * action body via this field rather than each tool re-reading
    * `opts.cwd`.
    *
    * When `project.scope === 'none'`, no opensip-tools project was found
    * above cwd. Project-scoped commands should error in this case (with
    * the "No opensip-tools project found" copy); `init` proceeds.
    */
   readonly project: ProjectContext;
   ```

3. Drop the `cwd: string` field from the `maybeOpenDashboard` opts (line 135–139):

   ```ts
   readonly maybeOpenDashboard: (opts: {
     openRequested: boolean;
     jsonOutput: boolean;
   }) => Promise<void>;
   ```

   Callers that needed `cwd` now read `ctx.project.projectRoot`.

**Verification:**
```bash
pnpm --filter=@opensip-tools/core build && pnpm --filter=@opensip-tools/core typecheck
```

Workspace-wide build fails until Task 1.3 + Phase 3 land. That's expected mid-phase.

**Commit:** `feat(core): add project: ProjectContext to ToolCliContext`

---

## Task 1.2: Resolve context in `pre-action-hook` and re-order bailouts

**Files:** [size: M]
- Modify: `packages/cli/src/bootstrap/pre-action-hook.ts`

**Context:** `installPreActionHook` (line 32) is the single site that has access to Commander-parsed opts (so it knows whether `--cwd` was explicit) AND fires before per-command actions. That makes it the resolution site.

**The ordering is load-bearing.** Side effects must happen AFTER all bailout decisions. The hook's new sequence:

1. Generate run id.
2. Read opts; resolve project context (pure, no side effects).
3. Run **bailout checks** — anything that can `process.exit` before any action runs:
   - Schema-version skew (Phase 6.3) — opens `process.exit(2)` if config is newer than CLI knows.
   - (Phantom-detect from Phase 7 is a warning, not a bailout — it can fire before or after the side-effect window.)
4. *Only now* set up side effects — log file backing, mark the datastore as available-on-demand.
5. Print the `Project:` header (Phase 2) — also strictly an output side effect, but stdout writes don't materialize directories so the ordering here is less critical.
6. Emit `cli.start` log line.

The `initLogFile` move from "early" to "late" closes the window where a bailout creates `.runtime/logs/` only to immediately abandon the run.

**Critically, `initLogFile` itself must be conditional on `existsSync(project.projectRoot) && project.scope === 'project'`.** The existing `existsSync(cwd)` guard (line 54) gated typo'd `--cwd` cases; the new guard also gates "no project found" (where `scope === 'none'`). A command running from `/tmp/empty` with no project up the tree must not create `/tmp/empty/opensip-tools/.runtime/logs/`.

**Steps:**

1. Add the import:

   ```ts
   import { resolveProjectContext } from '@opensip-tools/core';
   ```

2. Replace the existing preAction body (lines 33–67) with this re-ordered structure:

   ```ts
   program.hook('preAction', (_thisCommand, actionCommand) => {
     const runId = generatePrefixedId('run');
     setRunId(runId);

     const opts = actionCommand.opts();
     const cwd = (opts.cwd as string) ?? process.cwd();
     const cwdExplicit = actionCommand.getOptionValueSource('cwd') === 'cli';

     // 1. Merge project-config defaults (existing behavior).
     mergeConfigDefaults(opts, loadCliDefaults(cwd, opts.config as string | undefined));
     setSilent(true);
     if (opts.debug) setDebugMode(true);

     // 2. Resolve the project context — PURE, NO SIDE EFFECTS.
     //    Throws ValidationError if `--config <path>` was given and the path
     //    doesn't resolve to a file (Phase 0 contract).
     let project: ProjectContext;
     try {
       project = resolveProjectContext({
         cwd,
         cwdExplicit,
         explicitConfigPath: opts.config as string | undefined,
       });
     } catch (error) {
       // Strict --config error path. Surface the structured error and exit.
       const msg = error instanceof Error ? error.message : String(error);
       process.stderr.write(`✗ ${msg}\n`);
       process.exit(2);
     }

     // 3. Stash the context on opts under the COLLISION-FREE name
     //    `projectContext`. The literal `opts.project` is reserved for
     //    Commander's `--project [path]` flag in uninstall.ts; never set
     //    a `project` field on opts here.
     (opts as Record<string, unknown>).projectContext = project;

     // 4. Bailout window: schema check (Phase 6.3) and any other
     //    "this run cannot proceed" checks fire here, BEFORE any
     //    side-effect setup. Phase 6.3 may call process.exit(2).
     //    Phase 7's phantom-detect is a warning, not a bailout — it
     //    can fire here OR after side-effect setup. Phase 6/7 wire
     //    themselves into this slot.

     // 5. Side-effect setup, gated on a real project being present.
     if (project.scope === 'project' && existsSync(project.projectRoot)) {
       const projectPaths = resolveProjectPaths(project.projectRoot);
       initLogFile(projectPaths.logsDir);
       // Datastore is NOT opened here. It's exposed lazily via
       // ToolCliContext.datastore (Task 1.3); first access triggers the
       // SQLite open, which is the moment that creates .runtime/.
       // Commands that never touch ctx.datastore (uninstall --dry-run,
       // fit-list, completion, etc.) leave .runtime/ untouched.
     }

     // 6. Project header (Phase 2 wires this in).

     // 7. Structured start log.
     logger.info({
       evt: 'cli.start',
       module: 'cli:bootstrap',
       runId,
       command: actionCommand.name(),
       cwd,
       projectRoot: project.projectRoot,
       scope: project.scope,
     });

     if (project.walkedUp > 0) {
       logger.info({
         evt: 'cli.project.discovered',
         module: 'cli:bootstrap',
         runId,
         cwd,
         projectRoot: project.projectRoot,
         walkedUp: project.walkedUp,
       });
     }
   });
   ```

3. The `existsSync(cwd)` guard from the original line 54 is gone — replaced by `existsSync(project.projectRoot) && project.scope === 'project'`. The new guard is stricter (also catches `scope === 'none'`) and the older one is now redundant.

**Wiring:** Pre-action-hook is the resolution site. `opts.projectContext` is the bridge between preAction and per-command actions until Phase 3 migrates everything to `ctx.project`.

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli build && pnpm --filter=@opensip-tools/cli typecheck
```

**Commit:** `feat(cli): resolve ProjectContext in pre-action-hook with strict bailout ordering`

---

## Task 1.3: Lazy datastore + project getters on `ToolCliContext`

**Files:** [size: M]
- Modify: `packages/cli/src/cli-context.ts`
- Modify: `packages/cli/src/bootstrap/pre-action-hook.ts`

**Context:** `buildToolCliContext` assembles the literal `ToolCliContext` object once at bootstrap. Two of its fields (`project`, `datastore`) don't have meaningful values until preAction runs. Both must therefore be exposed via getters that read from module-level holders mutated by preAction.

The `datastore` getter is additionally responsible for **opening the connection on first access** — this is what makes the side-effect lazy. `openSqliteBackend` runs the moment a tool's action body actually reads `cli.datastore`. Tools that never read it (uninstall --dry-run, fit-list, completion, etc.) never trigger the open and never materialize `.runtime/`.

**Steps:**

1. Read `packages/cli/src/cli-context.ts` to confirm the current shape. The file is small; it constructs and returns a `ToolCliContext` object.

2. Add module-level holders + setters at the top of the file:

   ```ts
   import type { ProjectContext } from '@opensip-tools/core';
   import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';

   let currentProjectContext: ProjectContext | undefined;
   let datastoreCache: DataStore | undefined;

   /** Called by pre-action-hook once context is resolved. */
   export function setProjectContextForRun(ctx: ProjectContext): void {
     currentProjectContext = ctx;
     datastoreCache = undefined;  // reset for the new run
   }
   ```

3. Replace the construction of `ToolCliContext` to use getters for `project` and `datastore`:

   ```ts
   const ctx: ToolCliContext = {
     program,

     get project(): ProjectContext {
       if (!currentProjectContext) {
         throw new Error(
           'ToolCliContext.project accessed before pre-action-hook resolved it. ' +
           'This indicates a bootstrap-order bug — tools should not access project ' +
           'context during register() — only inside command actions.',
         );
       }
       return currentProjectContext;
     },

     get datastore(): unknown {
       if (datastoreCache) return datastoreCache;
       const project = currentProjectContext;
       if (!project) {
         throw new Error('Datastore accessed before pre-action-hook resolved the project context.');
       }
       if (project.scope !== 'project') {
         throw new Error(
           'Datastore accessed in a non-project context. The action body should have ' +
           'errored earlier with "No opensip-tools project found" before touching this.',
         );
       }
       const path = `${resolveProjectPaths(project.projectRoot).runtimeDir}/datastore.sqlite`;
       datastoreCache = DataStoreFactory.open({ backend: 'sqlite', path });
       logger.info({
         evt: 'cli.datastore.opened',
         module: 'cli:context',
         path,
       });
       return datastoreCache;
     },

     render,
     // ... existing fields
   };
   ```

   The getter pattern keeps the contract clean: tools see `ctx.datastore` as a simple field; the lazy-open indirection is invisible. The throw on `scope === 'none'` is defensive — it should never fire in production code because the per-command error paths catch the no-project case earlier.

4. In `pre-action-hook.ts`, call the setter inside the side-effect-setup block (where Task 1.2 currently has the `initLogFile` call):

   ```ts
   if (project.scope === 'project' && existsSync(project.projectRoot)) {
     const projectPaths = resolveProjectPaths(project.projectRoot);
     initLogFile(projectPaths.logsDir);
     setProjectContextForRun(project);  // armed for the action to read ctx.datastore lazily
   } else {
     // For scope === 'none' or missing projectRoot, set the context but
     // not the datastore. Tools that try to read cli.datastore in this
     // state hit the defensive throw — which is correct, because they
     // should have errored with "No opensip-tools project found" first.
     setProjectContextForRun(project);
   }
   ```

5. The `bootstrapCli` in `packages/cli/src/bootstrap/index.ts` previously opened the datastore eagerly (line 91–96 in the v1 file). Remove that block entirely. The `BootstrapResult` interface (line 67) drops its `datastore` field; `bootstrapCli` returns void or an empty object. Update `packages/cli/src/index.ts:47-51` (`main()`) to drop the `{ datastore }` destructure.

6. Datastore close: today the process exits without an explicit close (better-sqlite3 handles cleanup at process exit). Search `packages/cli/src/index.ts` and `packages/cli/src/bootstrap/index.ts` for `datastore.close()` or `process.on('exit',` — if any close logic exists, port it into the cli-context holder (e.g. `process.on('exit', () => datastoreCache?.close())`).

**Wiring:** preAction → resolveProjectContext → schema/bailout checks → if project ok, initLogFile + setProjectContextForRun → action body fires → tool calls `cli.datastore` for the first time → getter opens SQLite → handle cached for the rest of the run.

**Verification:**
```bash
pnpm build && pnpm typecheck && pnpm test
```

Critical manual smoke matrix:

```bash
# 1. Fresh tmpdir with no project — must NOT create .runtime/
TMPDIR=$(mktemp -d) && cd "$TMPDIR" && \
  node /path/to/cli/dist/index.js fit-list 2>&1 | head -5
find "$TMPDIR" -name ".runtime" -type d
# Expected: stderr has "No opensip-tools project found"; find returns nothing.

# 2. Project with --dry-run uninstall — must NOT create .runtime/
TMPDIR=$(mktemp -d) && cd "$TMPDIR" && \
  node /path/to/cli/dist/index.js init && \
  rm -rf opensip-tools/.runtime && \
  node /path/to/cli/dist/index.js uninstall --project --dry-run 2>&1
find "$TMPDIR/opensip-tools" -name ".runtime" -type d
# Expected: uninstall dry-run output; find returns nothing (the rm -rf wasn't undone).
# Note: --dry-run must NOT access cli.datastore. Verify by reading uninstall.ts.

# 3. Project with schemaVersion: 99 — must NOT create .runtime/
TMPDIR=$(mktemp -d) && cd "$TMPDIR" && \
  echo 'schemaVersion: 99' > opensip-tools.config.yml && \
  node /path/to/cli/dist/index.js fit-list 2>&1
find "$TMPDIR" -name ".runtime" -type d
# Expected: stderr shows "uses a newer schema than your CLI supports"; find returns nothing.

# 4. Real fit run from subdir — DOES create .runtime/ at the discovered root
cd <real-project>/packages/api && opensip-tools fit-list
find <real-project> -name ".runtime" -type d -not -path "*/node_modules/*"
# Expected: <real-project>/opensip-tools/.runtime exists; NO phantom at packages/api/opensip-tools/.runtime/.
```

**Commit:** `refactor(cli): lazy datastore + project getters on ToolCliContext`

---

## Task 1.4: Drop datastore open from `bootstrapCli`

**Files:** [size: S]
- Modify: `packages/cli/src/bootstrap/index.ts`
- Modify: `packages/cli/src/index.ts`

**Context:** `bootstrapCli` previously opened the datastore at lines 91–96. That's now Task 1.3's getter. This task is the cleanup — remove the eager open from bootstrap entirely.

**Steps:**

1. In `packages/cli/src/bootstrap/index.ts`, delete lines 91–98 (the datastore open block). The `BootstrapResult` interface loses its `datastore` field. Update the function's return type and signature.

2. In `packages/cli/src/index.ts:47-51` (`main()`), drop `{ datastore }` from the `bootstrapCli` destructure. Also drop the `datastore` argument from `buildToolCliContext` (line 53–57) — it no longer takes one.

3. Audit `buildToolCliContext`'s signature in `cli-context.ts` — drop the `datastore` parameter (it's now read from the holder).

**Verification:**
```bash
pnpm build && pnpm typecheck && pnpm test
```

**Commit:** `refactor(cli): remove eager datastore open from bootstrapCli`

---

## Phase 1 End-to-End Verification

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

After this phase the lazy-side-effects discipline is in place. The four-row smoke matrix from Task 1.3 must all pass: only the legitimate `fit` run from a real project creates `.runtime/`. Dry-runs, schema-bailouts, and no-project errors leave the filesystem clean.

> **Deferred:** Module-level holders (`currentProjectContext`, `datastoreCache`) are global state, which is fine for the single-process CLI but would be wrong for an in-process test harness running multiple CLI invocations in parallel. Phase 8 tests must not run two `preAction` cycles concurrently in one process; if integration tests need that, a per-invocation context-bag is the right next step.
