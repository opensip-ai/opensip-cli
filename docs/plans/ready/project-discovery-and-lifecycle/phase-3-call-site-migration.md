# Phase 3: Call-site migration

**Goal:** Migrate every `resolveProjectPaths(opts.cwd ?? process.cwd())` call site — both CLI-owned and tool-owned — to read from `ctx.project.projectRoot` (tools) or `opts.project.projectRoot` (CLI-only commands that don't receive the tool context). After this phase the phantom-scaffold bug is gone for every command (`fit`, `sim`, `graph`, dashboard, plugin, sessions, configure, uninstall — only `init` keeps its literal-cwd semantics, handled in Phase 4).
**Depends on:** Phase 1

**Ordering note:** This phase has TWO categories of call site:

- **CLI-owned commands (Tasks 3.1–3.5):** read from `opts.projectContext` (set by pre-action-hook in Phase 1.2). The field is deliberately named `projectContext` (not `project`) on Commander opts because `--project` is an existing flag value on `uninstall`; using `opts.project` would collide.
- **Tool packages (Tasks 3.6–3.8):** read from `ctx.project` (the new `ToolCliContext` field from Phase 1.1). No collision here — tools don't see Commander opts directly. Each tool's CliArgs bridge type carries the field as `args.project`.

Naming summary (consistent across all phases — read this if anything in the phase files looks inconsistent, the canonical names are here):

| Surface | Field name | Type |
|---------|-----------|------|
| Commander `opts` (set by preAction) | `opts.projectContext` | `ProjectContext` |
| `ToolCliContext` (tools read via getter) | `ctx.project` | `ProjectContext` |
| Tool `CliArgs` bridge (built from `opts` in the action callback) | `args.project` | `ProjectContext` |

Tasks inside each category are independent.

---

## Task 3.1: Migrate `init` call site (semantic shift, not just rewrite)

**Files:** [size: S]
- Modify: `packages/cli/src/commands/init.ts`

**Context:** `executeInit` (line 878) calls `resolveProjectPaths(cwd)` at line 882. `init`'s `cwd` semantics differ from every other command: it must operate on the *literal* cwd (or `--cwd <path>`) because the user is asking to scaffold *here*. Phase 4 adds the refusal logic that uses `args.project` to detect "you're inside an existing project."

This task threads the new field onto `args`:

```ts
readonly project: ProjectContext;  // resolved by pre-action-hook
```

…and updates the action-callback site (likely in `commands/register-init.ts` per the project's `register-X.ts` / `X.ts` split) to copy `opts.projectContext` into the args object.

**Steps:**

1. Extend the `CliArgs`-shaped args interface that `executeInit` takes (search for the args type at the top of `init.ts` or in a sibling types file). Add:

   ```ts
   readonly project: ProjectContext;
   ```

2. At the Commander `.action(async (opts) => { ... })` callback for `init` (look in `packages/cli/src/commands/register-init.ts`), read from the collision-free opts field:

   ```ts
   const project = opts.projectContext as ProjectContext;
   // existing args construction, plus:
   const args = { /* ... */, project };
   ```

3. `executeInit` itself: keep `resolveProjectPaths(args.cwd)` for now (Phase 4 will diff `args.cwd` against `args.project.projectRoot` to decide whether to refuse). No behavior change in this task.

**Wiring:** Commander → action callback reads `opts.projectContext` (set by pre-action-hook) → passes as `args.project` to `executeInit`.

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli build && pnpm --filter=@opensip-tools/cli typecheck
```

**Commit:** `refactor(cli): thread ProjectContext into init args (no behavior change)`

---

## Task 3.2: Migrate `uninstall` call site

**Files:** [size: S]
- Modify: `packages/cli/src/commands/uninstall.ts`

**Context:** `resolveProjectDir` (line 141) returns `resolve(opts.project)` when `--project [path]` is passed (the flag value), else `opts.cwd ?? process.cwd()`. The fallback should prefer the discovered root. The `--project` flag value continues to live on `opts.project`; the resolved context lives on `opts.projectContext` (no collision).

**Steps:**

1. In `uninstall.ts`, change line 143 from:

   ```ts
   return opts.cwd ?? process.cwd()
   ```

   to:

   ```ts
   const fallback = opts.projectContext?.projectRoot ?? opts.cwd ?? process.cwd();
   return fallback;
   ```

   Note: when the user passes explicit `--project /some/path`, line 142's `resolve(opts.project)` still wins. The discovery layer kicks in only as the fallback.

3. Extend `UninstallOptions` (search the file) with:

   ```ts
   readonly projectContext?: ProjectContext;
   ```

4. The command registration site lives in `packages/cli/src/commands/register-uninstall.ts`. Wire `projectContext: opts.projectContext as ProjectContext | undefined` into the options struct constructed there.

**Wiring:** Commander → action callback → `executeUninstall(opts)`. Pre-action-hook has already populated `projectContext`.

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli build && pnpm --filter=@opensip-tools/cli typecheck
```

**Commit:** `refactor(cli): use ProjectContext fallback in uninstall path resolution`

---

## Task 3.3: Migrate `plugin` call site

**Files:** [size: S]
- Modify: `packages/cli/src/commands/plugin.ts`

**Context:** `plugin list|add|remove|sync` all call `resolveProjectPaths` (lines 234, 375, 435 per earlier scan). Apply the same `opts.projectContext?.projectRoot ?? opts.cwd ?? process.cwd()` rewrite at each.

**Steps:**

1. Read `packages/cli/src/commands/plugin.ts` lines 220–440. Find each call site.
2. At each site, prefer `opts.projectContext?.projectRoot`. If the file uses a shared `resolveCwd(opts)`-style helper, update the helper once and all sites benefit.
3. Extend any options interfaces with `projectContext?: ProjectContext`.

**Wiring:** Same as 3.1/3.2.

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli build && pnpm --filter=@opensip-tools/cli typecheck
```

**Commit:** `refactor(cli): use ProjectContext in plugin subcommands`

---

## Task 3.4: Migrate `configure` call site

**Files:** [size: XS]
- Modify: `packages/cli/src/commands/configure.ts`

**Context:** Configure is user-scoped (`~/.opensip-tools/config.yml`). It may not actually need ProjectContext at all — if it does (e.g. it writes per-project state too), migrate; if not, the Phase 2 header suppression already keeps it clean.

**Steps:**

1. Search the file for `resolveProjectPaths(` — if no matches, this task is a no-op; mark it done.
2. If there are matches: rewrite as in 3.1–3.3.

**Wiring:** Same as 3.1.

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli build && pnpm --filter=@opensip-tools/cli typecheck
```

**Commit:** `refactor(cli): use ProjectContext in configure (if applicable)`

---

## Task 3.5: Migrate `sessions` call site

**Files:** [size: XS]
- Modify: `packages/cli/src/commands/register-sessions.ts`

**Context:** `sessions list|purge` are registered in `register-sessions.ts` (NOT in a `sessions.ts` file — the project uses a `register-X.ts` / `X.ts` split pattern, and sessions live entirely in the `register-` file). Both subcommands consume the datastore today via the context passed at register time; after Task 1.3 that datastore is lazy. Plus the file may read `cwd` for context resolution — apply the same rewrite if so.

**Steps:**

1. Read `packages/cli/src/commands/register-sessions.ts` (cited line 16). Verify whether it reads `opts.cwd` or `cli.datastore` directly. If it constructs `SessionRepo` from `cli.datastore`, no change needed — the new lazy datastore getter resolves correctly.
2. If it has any `resolveProjectPaths(opts.cwd ?? process.cwd())` call, rewrite to use the discovered root (same pattern as 3.3).
3. Extend any local options interface with `projectContext?: ProjectContext` if relevant.

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli build && pnpm --filter=@opensip-tools/cli typecheck
```

**Commit:** `refactor(cli): use ProjectContext in sessions`

---

## Task 3.6: Migrate `fitness` tool package

**Files:** [size: M]
- Modify: `packages/fitness/engine/src/tool.ts`
- Modify: `packages/fitness/engine/src/cli/dashboard.ts`
- Possibly modify: `packages/fitness/engine/src/cli/fit-runner.tsx`, other internal callers — search for `cwd` use within the package

**Context:** `fitness/engine/src/tool.ts:174` declares `.option('--cwd <path>', 'Target directory', process.cwd())`. The action callback at line 181 maps to `CliArgs` via `fitOptsToCliArgs` (line 103) which threads `cwd: opts.cwd` (line 109). Downstream `executeFit` / `executeGate` / `executeJsonMode` all consume `args.cwd`.

The migration: keep the `--cwd` flag (users still want to pass it; it's the trigger for `cwdExplicit = true` in Phase 0's resolver), but the *path used for filesystem operations* must come from `ctx.project.projectRoot`. Concretely:

- `--cwd /elsewhere` → user explicitly chose `/elsewhere`. Pre-action-hook resolves from there. `ctx.project.projectRoot` is either `/elsewhere` itself (if `/elsewhere/opensip-tools.config.yml` exists) or an ancestor of `/elsewhere`. Tool uses `ctx.project.projectRoot`.
- No `--cwd` → `process.cwd()`. Same resolution. Tool uses `ctx.project.projectRoot`.

Result: the tool never reads `opts.cwd` directly for path resolution. It might still read `opts.cwd` for messaging (e.g. "running from <cwd>"); that's fine. The discriminator is "is this a *resolution* read or a *display* read?"

The `dashboard.ts` call at `openDashboard(projectDir?, datastore?)` (line 92) currently takes `projectDir` from its caller. Caller-side fix in this task: every site that calls `openDashboard` passes `ctx.project.projectRoot`. `loadGraphCatalog` / `loadEditorProtocol` (lines 56, 71) called inside `openDashboard` also use `projectDir` — that flows correctly once the entry is correct.

**Steps:**

1. In `tool.ts`:
   - Update `fitOptsToCliArgs` to also forward the context. Either add a `project` field to `CliArgs` (preferred — explicit) or pass the context as a second argument. Pick the explicit field:

     ```ts
     function fitOptsToCliArgs(
       opts: FitOptions & { quiet?: boolean; open?: boolean },
       project: ProjectContext,
     ): CliArgs {
       return {
         // ... existing fields including cwd: opts.cwd (preserved for display)
         project,
       };
     }
     ```

   - Update every `.action(async (opts) => { const args = fitOptsToCliArgs(opts); ... })` site to:

     ```ts
     .action(async (opts: ...) => {
       const args = fitOptsToCliArgs(opts, cli.project);
       // ... existing dispatch
     });
     ```

   - `CliArgs` is the bridge type imported from contracts (search the file for its import). Add the `project: ProjectContext` field there. NOTE: `CliArgs` is shared with sim/graph — this is fine, they want the field too.

2. In `executeFit` / `runListMode` / `runRecipesMode` / `runJsonMode` / `runGateMode` (search file for these names) — find every `args.cwd` use that is a *resolution* read (passed into `resolveProjectPaths`, `readdirSync`, `loadSignalersConfig`, etc.) and rewrite to `args.project.projectRoot`. Display reads ("Running against <cwd>") can keep `args.cwd` if useful, though `args.project.projectRoot` is usually what the user wants to see.

3. In `dashboard.ts`:
   - Change `openDashboard(projectDir?: string, ...)` callers (search `packages/cli/src/bootstrap/dashboard.ts` and any `cli.maybeOpenDashboard` invocations) to pass `ctx.project.projectRoot`.
   - Inside `openDashboard`, the existing `resolveProjectPaths(projectDir ?? process.cwd())` (lines 72, 135) still works — `projectDir` now reliably arrives from the caller.

4. `maybeOpenDashboard` on `ToolCliContext` (Task 1.1 dropped the `cwd: string` opt field). Update every `cli.maybeOpenDashboard({ openRequested, jsonOutput, cwd: args.cwd })` site in `tool.ts` to drop the `cwd` field:

   ```ts
   await cli.maybeOpenDashboard({ openRequested: Boolean(opts.open), jsonOutput: Boolean(args.json) });
   ```

   The receiving impl in `packages/cli/src/bootstrap/dashboard.ts` reads `cli.project.projectRoot` instead of the now-removed opt.

**Wiring:** Tool's Commander action → fitOptsToCliArgs(opts, cli.project) → CliArgs carries project → executeFit reads args.project.projectRoot for all filesystem resolution.

**Verification:**
```bash
pnpm --filter=@opensip-tools/fitness build && pnpm --filter=@opensip-tools/fitness typecheck && \
pnpm --filter=@opensip-tools/fitness test
```

Manual smoke from a subdir of this repo:

```bash
pnpm build
cd packages/cli && node ../../packages/cli/dist/index.js fit --json > /dev/null
# Expected: the run created /repo-root/opensip-tools/.runtime/ entries, NOT packages/cli/opensip-tools/.runtime/.
```

**Commit:** `refactor(fitness): read project root from ToolCliContext.project`

---

## Task 3.7: Migrate `simulation` tool package

**Files:** [size: S]
- Modify: `packages/simulation/engine/src/tool.ts`

**Context:** `simulation/engine/src/tool.ts:54` declares `.option('--cwd <path>', 'Target directory', process.cwd())`. The action at line 60 uses `toolOptsToCliArgs('sim', opts)` (line 64). Same shape as fitness.

**Steps:**

1. Update `toolOptsToCliArgs` (find its definition — likely top of `tool.ts` or imported) to forward `project`:

   ```ts
   function toolOptsToCliArgs(
     command: 'sim',
     opts: ...,
     project: ProjectContext,
   ): CliArgs {
     return {
       // ... existing fields
       project,
     };
   }
   ```

2. Update the `.action` callback to pass `cli.project`.

3. In `executeSim` (search for its definition), rewrite resolution reads from `args.cwd` to `args.project.projectRoot`.

4. The `maybeOpenDashboard` call (line 87) drops its `cwd` field — same as 3.6.

**Wiring:** Same as 3.6.

**Verification:**
```bash
pnpm --filter=@opensip-tools/simulation build && pnpm --filter=@opensip-tools/simulation typecheck && \
pnpm --filter=@opensip-tools/simulation test
```

**Commit:** `refactor(simulation): read project root from ToolCliContext.project`

---

## Task 3.8: Migrate `graph` tool package

**Files:** [size: M]
- Modify: `packages/graph/engine/src/tool.ts`
- Modify: `packages/graph/engine/src/cli/graph.ts`

**Context:** `graph/engine/src/tool.ts:92` declares `--cwd`, with a more complex action body (lines 113+). The graph tool also has its own `--report-to`, `--package`, `--packages`, `--baseline` flags; none of those affect this migration except that the args carry more fields.

**Steps:**

1. In `tool.ts`, the action body around line 113 reads `opts.cwd` directly. Add `cli.project` into the args struct it builds for `runGraph(...)`. Rewrite every `opts.cwd` resolution-read to `cli.project.projectRoot`.

2. `runGraph` lives in `packages/graph/engine/src/cli/graph.ts` (search for its definition; the file has `reportTo`, `apiKey`, etc. signals — confirm it's the right file). Update its signature to take `project: ProjectContext` and rewrite resolution reads accordingly.

3. `graph` does NOT call `maybeOpenDashboard` (it's not in `tool.ts:graph.ts` flow). Skip the dashboard piece for this task.

**Wiring:** Same as 3.6/3.7.

**Verification:**
```bash
pnpm --filter=@opensip-tools/graph build && pnpm --filter=@opensip-tools/graph typecheck && \
pnpm --filter=@opensip-tools/graph test
```

**Commit:** `refactor(graph): read project root from ToolCliContext.project`

---

## Phase 3 End-to-End Verification

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

Manual smoke matrix from a subdirectory of this repo:

```bash
pnpm build
cd packages/cli && for cmd in fit-list fit-recipes "fit --json" "sim --json" sessions plugin list; do
  echo "=== $cmd ===";
  node ../../packages/cli/dist/index.js $cmd 2>&1 | head -3;
done
# Expected: every command's header (where not suppressed) shows the repo root, not packages/cli.
# .runtime/ artifacts after the run live only at <repo-root>/opensip-tools/.runtime/.
```

Confirm via:

```bash
find packages/cli -name "opensip-tools" -type d -not -path "*/node_modules/*" 2>/dev/null
# Expected: no output (no phantom dirs anywhere under packages/cli/).
```

> **Deferred:** Third-party tool packages that consume the previous `ToolCliContext` shape will fail to compile against the new contract until they add `project: ProjectContext` to their context. CHANGELOG entry (Phase 5) documents this; the upgrade path for third-party tool authors is a one-line change in their `register(cli)` hook.
