# Phase 0: ProjectContext resolver

**Goal:** Introduce `resolveProjectContext(...)` as a pure, testable one-shot resolver in the kernel. Walks ancestors using the existing `resolveProjectConfigPath` (so the `package.json#opensip-tools.configPath` pointer is honored at each level). Returns a single context object — `cwd`, `cwdExplicit`, `projectRoot`, `configPath`, `walkedUp`, `scope` — that every downstream consumer reads from. No callers wired yet; Phase 1 threads it through.
**Depends on:** —

---

## Task 0.1: Create `ProjectContext` + `resolveProjectContext` in core

**Files:** [size: M]
- Create: `packages/core/src/lib/project-context.ts`
- Modify: `packages/core/src/index.ts`

**Context:** Today the CLI smears `cwd` + `--cwd` + (implicitly) "is this a project at all?" across every command's opts. Every consumer calls `resolveProjectPaths(opts.cwd ?? process.cwd())` (`packages/core/src/lib/paths.ts:99`), which blindly appends `'opensip-tools'` to whatever path it's given. That's why running from a subdirectory creates a phantom scaffold there.

The fix is to compute a single `ProjectContext` once per CLI invocation. Every downstream consumer reads from it. The walker honors the same three-tier resolution as `resolveProjectConfigPath` (`packages/core/src/config-resolution.ts:63`): `--config` explicit path → `package.json#opensip-tools.configPath` pointer at the ancestor → default `<ancestor>/opensip-tools.config.yml`. This matches the contract existing tests cover and means a project that uses the `package.json` pointer is still discoverable.

The function lives in `core/lib/` because every tool (`fitness`, `simulation`, `graph`, future plugins) needs it — putting discovery in `cli` would force tools to re-implement it.

**Steps:**

1. Create `packages/core/src/lib/project-context.ts`:

   ```ts
   import { existsSync } from 'node:fs';
   import { dirname, resolve, sep } from 'node:path';

   import { resolveProjectConfigPath } from '../config-resolution.js';
   import { logger } from './logger.js';

   const MODULE_TAG = 'core:project-context';

   /** Resolved per-invocation project context — read by every downstream consumer. */
   export interface ProjectContext {
     /** Literal cwd at invocation (or the value of an explicit `--cwd` flag). Absolute. */
     readonly cwd: string;
     /** True when the user passed `--cwd` on the command line (vs Commander defaulting it). */
     readonly cwdExplicit: boolean;
     /**
      * Resolved project root. If an ancestor has a config file, that ancestor.
      * Otherwise equals `cwd` (no discovery; commands like `init` fall back to here).
      */
     readonly projectRoot: string;
     /** Resolved config file path at `projectRoot`, or undefined when no project was found. */
     readonly configPath: string | undefined;
     /** Ancestor steps walked from `cwd` to `projectRoot`. 0 when cwd is the root. */
     readonly walkedUp: number;
     /** `'project'` iff a config was discovered; `'none'` otherwise. */
     readonly scope: 'project' | 'none';
   }

   export interface ResolveProjectContextInput {
     /** Literal cwd or `--cwd` value. */
     readonly cwd: string;
     /** True when `--cwd` was passed on the command line. */
     readonly cwdExplicit: boolean;
     /** Optional `--config <path>` override. Honored at the *start* ancestor only. */
     readonly explicitConfigPath?: string;
     /**
      * Absolute path beyond which the walker stops. Used by tests to prevent the
      * walker from escaping fixture directories and finding the real repo's config
      * above. Defaults to the filesystem root.
      */
     readonly stopAt?: string;
   }

   /**
    * Resolve the project context for an invocation. Pure function — no side
    * effects beyond debug logging.
    *
    * Walks from `cwd` upward. At each ancestor, attempts
    * `resolveProjectConfigPath(ancestor, explicitConfigPath?)` — which honors
    * the `package.json#opensip-tools.configPath` pointer. First ancestor where
    * it succeeds wins. `explicitConfigPath` is only honored at the starting
    * ancestor (cwd), matching the semantics of `--config`: it's an override of
    * the resolved path, not a globally-applied filename.
    */
   export function resolveProjectContext(input: ResolveProjectContextInput): ProjectContext {
     const start = resolve(input.cwd);
     const stop = input.stopAt ? resolve(input.stopAt) : null;
     let dir = start;
     let prev = '';
     let walkedUp = 0;

     while (dir !== prev) {
       const explicit = walkedUp === 0 ? input.explicitConfigPath : undefined;
       const configPath = tryResolveConfig(dir, explicit);
       if (configPath) {
         logger.debug({
           evt: 'project.root.resolved',
           module: MODULE_TAG,
           cwd: start,
           projectRoot: dir,
           configPath,
           walkedUp,
         });
         return {
           cwd: start,
           cwdExplicit: input.cwdExplicit,
           projectRoot: dir,
           configPath,
           walkedUp,
           scope: 'project',
         };
       }
       if (stop && dir === stop) break;
       prev = dir;
       dir = dirname(dir);
     }

     logger.debug({
       evt: 'project.root.not-found',
       module: MODULE_TAG,
       cwd: start,
       walkedTo: dir,
     });
     return {
       cwd: start,
       cwdExplicit: input.cwdExplicit,
       projectRoot: start,
       configPath: undefined,
       walkedUp: 0,
       scope: 'none',
     };
   }

   /**
    * Wrap `resolveProjectConfigPath` so a throw at a given ancestor during
    * ancestor walking is just "no config here." But if the caller passed
    * `--config <path>`, an unresolvable explicit path is a USER ERROR and
    * must propagate — silently walking up to find some other config when
    * the user explicitly named one is exactly the surprising-side-effect
    * class this whole plan is trying to eliminate.
    */
   function tryResolveConfig(dir: string, explicit: string | undefined): string | undefined {
     try {
       const resolved = resolveProjectConfigPath(dir, explicit);
       return existsSync(resolved) ? resolved : undefined;
     } catch (error) {
       // Propagate explicit-path errors so the caller can surface an
       // actionable "your --config path doesn't resolve to a file" error.
       // Only swallow when we're doing implicit ancestor discovery.
       if (explicit !== undefined) throw error;
       return undefined;
     }
   }
   ```

   Notes on the design:
   - The walker leans on `resolveProjectConfigPath` so the `package.json#opensip-tools.configPath` pointer is honored at every ancestor (existing tests at `packages/core/src/__tests__/config-resolution.test.ts` cover that contract — verify they still pass).
   - `explicitConfigPath` is only applied at the starting ancestor and is **strict**: if the user passed `--config <path>` and that path doesn't resolve to a file, the resolver propagates `resolveProjectConfigPath`'s `ValidationError`. It does NOT silently walk up looking for some other config. The walker only swallows errors during implicit ancestor discovery. (Prior plan-review feedback caught a bug here: an earlier draft swallowed every error, so `--config /typo.yml` would have silently used some ancestor's config — exactly the surprising side-effect class the rest of the plan eliminates.)
   - When no project is found anywhere up the tree, the context still returns with `projectRoot: cwd` (and `scope: 'none'`). Commands like `init` use `scope === 'none'` as the green-light to scaffold at `cwd`. Commands that require a project (`fit`, `sim`, `graph`, `dashboard`, …) use `scope === 'none'` to emit the "No opensip-tools project found" error.
   - `cwdExplicit` is captured here rather than computed downstream so the rest of the CLI never re-derives it. Phase 1 plumbs it from Commander's `getOptionValueSource('cwd') === 'cli'`.

2. Re-export from `packages/core/src/index.ts`. Add alongside the existing `resolveProjectPaths` / `resolveUserPaths` line:

   ```ts
   export {
     resolveProjectContext,
     type ProjectContext,
     type ResolveProjectContextInput,
   } from './lib/project-context.js';
   ```

**Wiring:** Standalone in this phase. Phase 1 wires the resolver into `pre-action-hook` and extends `ToolCliContext` with the resulting context.

**Verification:**
```bash
pnpm --filter=@opensip-tools/core build && pnpm --filter=@opensip-tools/core typecheck
```

**Commit:** `feat(core): add resolveProjectContext one-shot resolver`

---

## Task 0.2: Unit tests for `resolveProjectContext`

**Files:** [size: M]
- Create: `packages/core/src/lib/__tests__/project-context.test.ts`

**Context:** The resolver is the architectural anchor of the whole plan, so the unit suite must be comprehensive. The `stopAt` parameter is the critical test-isolation knob — without it, tests would escape their fixture roots and find this very repo's `opensip-tools.config.yml`, producing flaky-on-someone-else's-machine results.

**Steps:**

1. Create the test file with these cases:
   - **cwd is the root itself.** Fixture: tmpdir with `opensip-tools.config.yml` at top. Assert `{ projectRoot: <tmpdir>, walkedUp: 0, scope: 'project', configPath: <tmpdir>/opensip-tools.config.yml }`.
   - **Walks up one level.** Fixture: tmpdir with `subdir/`. Config at tmpdir root. Call with `cwd = <tmpdir>/subdir`. Assert `walkedUp: 1`.
   - **Walks up several levels.** Fixture: `tmpdir/a/b/c/d/`. Config at tmpdir. Call from `.../d`. Assert `walkedUp: 4`.
   - **No project found.** Fixture: empty tmpdir. Call with `cwd = <tmpdir>`, `stopAt = <tmpdir>`. Assert `scope: 'none'`, `projectRoot === cwd`, `configPath: undefined`, `walkedUp: 0`.
   - **`stopAt` halts the walk.** Fixture: `tmpdir/inner/` with no config. Call with `cwd = <tmpdir>/inner`, `stopAt = <tmpdir>`. Assert `scope: 'none'` (would otherwise escape to the real repo).
   - **Nearest ancestor wins.** Fixture: configs at both `tmpdir/` and `tmpdir/outer/`. Call from `tmpdir/outer/inner/sub/`. Assert `projectRoot === tmpdir/outer`.
   - **`package.json#opensip-tools.configPath` pointer honored at ancestor.** Fixture: `tmpdir/package.json` with `{ "opensip-tools": { "configPath": "config/opensip-tools.config.yml" } }` + `tmpdir/config/opensip-tools.config.yml`. Call from `tmpdir/sub/`. Assert `configPath` is the pointer target, `projectRoot === tmpdir`.
   - **`explicitConfigPath` honored at cwd only.** Fixture: `tmpdir/`, no default config, user passes `explicitConfigPath: /abs/elsewhere/config.yml` (existing file). Call from `tmpdir/`. Assert `projectRoot === tmpdir`, `configPath === /abs/elsewhere/config.yml`.
   - **`explicitConfigPath` non-existent file → throws.** Same setup, but explicit path points to a non-existent file. Assert the function THROWS `ValidationError` (does NOT walk up — explicit-path errors are strict).
   - **`cwdExplicit` flows through.** Assert both `true` and `false` cases.
   - **cwd resolved to absolute.** Pass relative cwd. Assert returned `cwd` is absolute.
   - **Logs `project.root.resolved` on success.** Mock `logger.debug`; assert one call with `cwd`, `projectRoot`, `configPath`, `walkedUp`.
   - **Logs `project.root.not-found` on miss.** Same for miss path.

2. Use `node:fs/promises` `mkdtemp` for fixtures, `os.tmpdir()` as parent, clean up in `afterEach`. Follow existing test patterns in `packages/core/src/lib/__tests__/` or `packages/core/src/__tests__/config-resolution.test.ts` (which already does config-path fixturing).

3. Logger mocking pattern: search `packages/core/src/lib/__tests__/` for prior examples of `vi.spyOn(logger, 'debug')`.

**Wiring:** Self-contained tests.

**Verification:**
```bash
pnpm --filter=@opensip-tools/core test project-context
```

**Commit:** `test(core): cover resolveProjectContext discovery + stopAt + package.json pointer`

---

## Phase 0 End-to-End Verification

```bash
pnpm --filter=@opensip-tools/core build && \
pnpm --filter=@opensip-tools/core typecheck && \
pnpm --filter=@opensip-tools/core test && \
pnpm --filter=@opensip-tools/core lint
```

After this phase: `resolveProjectContext` and `ProjectContext` are importable from `@opensip-tools/core`, all unit tests pass, and zero existing call sites have changed.

> **Deferred:** Log-event-name policy for `project.root.resolved` / `project.root.not-found` named here but not vetted against the broader event taxonomy.
