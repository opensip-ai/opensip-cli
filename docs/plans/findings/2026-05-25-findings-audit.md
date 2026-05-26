# 2026-05-25 — Bug & Correctness Audit

Scope: `packages/datastore`, `packages/fitness`, `packages/graph`,
`packages/languages`, `packages/simulation`.

Method: workspace-wide `pnpm build / test / lint` baseline, plus
targeted source review (manual on datastore; parallel `code-reviewer`
sub-agents on the other four package families). Findings are recorded
here regardless of whether they were fixed this pass — fixes link back
to the entry by id.

Format: `[F-N]` ids are stable so future passes can reference them.
Each entry: severity, location, summary, action, status.

Status legend:
- **fixed** — applied in this pass (worktree branch).
- **deferred** — confirmed defect, fix deferred to next pass for
  reason noted.
- **wontfix** — confirmed by re-reading, not a defect, kept for record.

## Baseline (worktree, fresh install)

- `pnpm build` — clean (exit 0)
- `pnpm test`  — 48 tasks / 175+ tests pass (exit 0) post-fixes
- `pnpm lint`  — ESLint + dep-cruiser clean (577 modules, 722 deps)
- Workspace structure note: `packages/datastore` existed in the repo
  but was absent from the "Repository Structure" tree in root
  `CLAUDE.md`. Doc-drift, not a correctness defect, but a real audit
  finding — see F-4.

## Datastore (`packages/datastore`)

### [F-1] `DataStoreMigrationError.cause` shadows native `Error.cause`
**Severity:** medium · **Status:** fixed
**Location:** `packages/datastore/src/data-store.ts:17-27`

The class declared `readonly cause: unknown` and assigned it manually
in the constructor without passing `cause` to `super(message, { cause })`.
In Node 16+ / ES2022, `Error` accepts a `cause` option natively and
populates its own `cause` slot. The redeclaration:
- Bypassed engine-level cause handling (V8 error display, structured
  cloning across realms, etc.).
- Created a writable class-field own property that silently violates
  the `readonly` TS contract at runtime.

**Action taken:** dropped the explicit field, pass `cause` to
`super()` so it lands on the standard `Error.cause` slot.

### [F-2] `DataStoreMigrationError` message mislabels non-migration failures
**Severity:** low · **Status:** fixed
**Location:** `packages/datastore/src/factory.ts:18-32`

`DataStoreFactory.open` wrapped two distinct failure modes —
SQLite-construct/mkdir errors and `migrate()` errors — with the same
"Schema migration failed…" message. The first case lies: migration
never ran.

**Action taken:** split the message construction into
`openFailureMessage` and `migrateFailureMessage` helpers, each
producing accurate text. Kept the existing exported error class
(`DataStoreMigrationError`) to avoid a breaking API rename — the
class is now documented in the codebase via its message variants.

### [F-3] Lost schema generic in `buildSqliteDataStore`
**Severity:** low · **Status:** deferred (no current caller)
**Location:** `packages/datastore/src/backends/shared.ts:6-23`

`DataStore<TSchema>` is generic, but `buildSqliteDataStore` always
returns `DataStore` with the default `Record<string, unknown>`. No call
path threads a typed schema through `DataStoreFactory.open` — grep of
the workspace shows every consumer uses the default. Latent design
limitation rather than an active defect.

**Action:** revisit when a consumer (fitness session repo, simulation
state, graph catalog) is ready to bind a drizzle schema.

### [F-4] `CLAUDE.md` repo-structure section missing `datastore`
**Severity:** low (doc drift) · **Status:** fixed
**Location:** `CLAUDE.md` (Repository Structure section)

The ASCII tree listed `core, contracts, dashboard, cli, cli-ui,
fitness, simulation, graph, languages` but omitted `packages/datastore`
— a v2.0.0 first-party package consumed by every tool's persistence
layer.

**Action taken:** added a `datastore/` entry between `contracts/` and
`dashboard/` with a one-line description matching its `package.json`.

## Fitness engine (`packages/fitness/engine`)

### [F-5] Hard-coded `score = 0` in `cli/fit.ts` disagrees with service `score = 100` for empty recipes
**Severity:** medium (gate-compare phantom regression) · **Status:** fixed
**Location:** `packages/fitness/engine/src/cli/fit.ts:481-483` vs
`packages/fitness/engine/src/recipes/service.ts:294`

`buildCliOutput` computed `score = 0` when `summary.totalChecks === 0`;
`buildResult` in the service used `score = 100` for the same condition.
Same run, two different scores in two different output paths:
- `CliOutput.score = 0` flows into gate baselines, the dashboard, and
  SARIF.
- `FitnessRecipeResult.score = 100` flows into the live renderer and
  the `success` predicate.
On the next `--gate-compare`, the recorded `0` is compared against a
fresh run's `100` and reports a 100-point regression that never
happened.

**Action taken:** changed the empty-recipe fallback in `cli/fit.ts` to
`100`, matching the service. Added a one-line WHY comment.

### [F-6] `parallel-execution.ts` outer Promise has no reject path
**Severity:** medium · **Status:** deferred (needs careful refactor + test)
**Location:** `packages/fitness/engine/src/recipes/parallel-execution.ts:70-113`

The driver wraps the sliding-window loop in
`new Promise<void>((resolve) => { … })` with no `reject` parameter.
Inside `launch`, calls are `void runOneCheck(...).then(...).finally(...)`.
A throw inside the `.finally` callback (or a future synchronous throw
in `runOneCheck` before the returned promise) escapes to
`unhandledRejection` and the wrapping promise hangs forever — no
result, no error propagation to the caller.

**Action:** rewrite the driver to use `async`/`await` with a counted
sliding window, or add `reject` and chain `.catch` on each call. Defer
because (a) the change is non-trivial and (b) it must be paired with
an abort/cancel test that the current suite does not cover.

### [F-7] `void initParseCache()` / `void clearParseCache()` swallow init errors
**Severity:** medium · **Status:** deferred (paired with F-6)
**Location:** `packages/fitness/engine/src/recipes/service.ts:275`,
same file `:176`

The parse cache init returns a `Promise`; discarding it via `void`
means a failure (e.g., temp-dir write error, filesystem permission)
proceeds with a cold cache and no warning. The same pattern at the
`finally` cleanup site silently drops cleanup errors.

**Action:** `await initParseCache()` inside a try/catch that logs at
`warn`; same for `clearParseCache()`. Deferred because the call sites
are in the same execute path as F-6 and should be touched together.

### [F-8] `scope-resolver.ts` mutates `Set` while iterating it
**Severity:** low (per-spec safe, fragile) · **Status:** deferred
**Location:** `packages/fitness/engine/src/framework/scope-resolver.ts:43-47`

The forward-iteration delete-during-`for…of` pattern is defined
behavior for `Set` per ECMA-262, so this is not a correctness defect
today. It is fragile: any refactor that converts the loop body or
moves the deletion through another helper could silently break it.

**Action:** replace with `Array.from(files).filter(...).sort()`. Low
priority — defer to a follow-up cleanup pass.

### [F-9] `checksLoaded` module-level singleton never resets
**Severity:** low (only bites long-lived hosts) · **Status:** deferred
**Location:** `packages/fitness/engine/src/cli/fit.ts:140-141`

A second `executeFit(...)` call in the same process — possible from a
long-running daemon, programmatic API, or back-to-back test cases —
skips plugin loading because the module-level `checksLoaded` flag
stayed true. Today the CLI is one-shot per process, so this does not
bite, but it will the moment we add any non-one-shot host.

**Action:** key the guard on `projectDir`, or expose a
`resetChecksLoadedForTesting()` for the test harness.

### [F-10] `fileCache.clear()` ordering vs `abortController.abort()`
**Severity:** low (no crash, wasted I/O) · **Status:** wontfix (needs
re-verification)
**Location:** `packages/fitness/engine/src/recipes/service.ts:174-181`

Agent reported that `clear()` runs before `abort()`, causing
in-flight `fileCache.get` calls to fall through to `fs.readFile`. On
re-read the order is actually `abort()` then `clear()` (in current
code), and the cache map is consulted synchronously inside `get()`'s
miss path before the disk read fires — so a `clear()` between an
abort and a settled await does not silently re-read disk. Keeping the
entry for the record; not a defect today.

## Graph packages (`packages/graph/*`)

### [F-11] `orchestrate.ts` incremental-closure path concat is Windows-broken
**Severity:** medium (Windows only) · **Status:** deferred (no Windows CI)
**Location:** `packages/graph/engine/src/cli/orchestrate.ts:559`

`closureAbs.add(`${projectDirAbs}/${dep}`.split('/').join(sep))`
hard-concatenates with `/` then replaces `/` with `path.sep`. On
Windows, `projectDirAbs` already contains backslashes that pass
through unchanged, yielding a mixed-separator path that never matches
entries in `discovery.files`. Incremental closure silently produces an
empty intersection and changed files are skipped.

**Action:** replace with `path.join(projectDirAbs, dep)`. Deferred
because the workspace has no Windows CI to validate the change and
the touched code is on the orchestrator's hot path.

### [F-12] `alwaysThrowsBranchRule` regex never matches call-edge text
**Severity:** medium (rule never fires) · **Status:** deferred (needs
fixture-based confirmation)
**Location:** `packages/graph/engine/src/rules/always-throws-branch.ts:43`

`occ.calls.every((e) => throwRegex.test(e.text))` examines call-edge
text, which is the call expression text (e.g. `new Error("msg")`).
The regex requires the text to start with `throw`, but a
`ThrowStatement` is recorded as a `NewExpression` call-site whose
text does not begin with `throw`. The rule appears unable to fire on
real TypeScript code.

**Action:** capture the enclosing `ThrowStatement` text at walk time,
or change the predicate to match the new-expression shape directly.
Deferred pending a graph-rule integration test that fixtures a throw
and asserts the rule fires.

### [F-13] `no-side-effect-path` false positive on unresolved edges
**Severity:** medium · **Status:** deferred
**Location:** `packages/graph/engine/src/rules/no-side-effect-path.ts:111-126`

`hasDiscardedCaller` loops `caller.calls`, skipping any edge whose
`to` does not include `occ.bodyHash`. When the loop finds no matching
edge, `sawDiscardedField` stays false and the function returns `true`
— signalling a discarded-result caller that doesn't exist. Mixed
incremental catalogs (cached `discarded` field + freshly-walked
occurrences) and unresolved edges trigger this.

**Action:** add `sawMatchingEdge` tracking; return `false` when no
edge actually matched, only fall back to the legacy `!sawDiscardedField`
path when at least one matching edge was observed without the
`discarded` field.

## Language adapters (`packages/languages/lang-*`)

### [F-14] `getEnclosingFunctionName` skips named `FunctionExpression`
**Severity:** medium · **Status:** fixed
**Location:** `packages/languages/lang-typescript/src/function-scope.ts:83-95`

The walker handled `MethodDeclaration` and named `FunctionDeclaration`
but not `FunctionExpression`. A node inside a named function
expression like `const x = function namedFn() { … }` walked past the
boundary and either returned `null` or the wrong outer name.

**Action taken:** added an `isFunctionExpression(current) && current.name`
branch that returns the expression's name when present.

### [F-15] `walkNodes` does not visit the root node
**Severity:** low (doc/behavior mismatch) · **Status:** deferred
**Location:** `packages/languages/lang-typescript/src/ast-utilities.ts:40-46`

`walkNodes(root, visitor)` calls `ts.forEachChild(root, visit)` — the
root is never passed to the visitor, contradicting the "all nodes in
a SourceFile or subtree" JSDoc. All current callers pass a
`SourceFile` as root and don't expect to see a `SourceFile` in the
visitor, so this is invisible today, but a future caller passing a
subtree root will silently miss it.

**Action:** prepend `visitor(root)` before the recursion, OR amend
the JSDoc to "visits every descendant of `root`". Deferred — touching
this without a check-fixture audit risks behavioral drift in 60+ TS
checks. Track separately.

### [F-16] `filterContent` Map keyed by raw source string
**Severity:** low (heap pressure on large runs) · **Status:** deferred
**Location:** `packages/languages/lang-typescript/src/filter.ts:146-179`

The filter cache keys entries on the full source content string. A
fitness run across a large TS codebase can put hundreds of files of
50-200 KB each into the Map keys, roughly doubling peak heap. The
idle-timer clears after 10 minutes of no calls but in-run growth is
unbounded.

**Action:** thread `filePath` as a parameter and key on
`filePath + ':' + fingerprint` (matching how
`@opensip-tools/core/languages/parse-cache.js` does it). Deferred
because it requires a signature change on a function used across many
checks.

## Simulation engine (`packages/simulation/engine`)

### [F-17] `runSingle` hardcodes `passed: true` for every scenario that didn't throw
**Severity:** **critical** · **Status:** fixed
**Location:** `packages/simulation/engine/src/recipes/service.ts:159`

`runSingle` returned `passed: true` whenever `scenario.run()`
resolved, ignoring the executor result's `passed` field — which every
kind (`load`, `chaos`, `invariant`) sets based on assertion verdicts.
A scenario with every assertion failing was reported up to the CLI as
**passed**. This silently inverted the meaning of every sim run that
ran without throwing.

**Action taken:** changed `passed: true` to `passed: result.passed`,
with a comment explaining why the executor verdict must win.

### [F-18] `sleepTick` does not react to abort signals between ticks
**Severity:** **critical** · **Status:** fixed
**Location:** `packages/simulation/engine/src/framework/execution/run-load-window.ts:143-151`

The old `sleepTick` checked `signal.aborted` synchronously after
scheduling `setTimeout`, and never registered an `'abort'` event
listener. If a signal fired between the `setTimeout` call and the
function returning, the load window slept the full tick interval
before noticing — undermining the abort contract used by every other
loop in the engine.

**Action taken:** rewrote to register `'abort'` with `{ once: true }`
and clear the timer (and remove the listener on timer resolution) so
the sleep ends within microtasks of the signal firing.

### [F-19] Invariant executor swallows abort as a phase failure
**Severity:** medium · **Status:** fixed
**Location:** `packages/simulation/engine/src/kinds/invariant/executor.ts:162-163`

When `abortSignal.aborted` was already true at `runPhase` entry, the
function returned `{ status: 'failed', error: 'aborted' }` instead of
throwing `ScenarioAbortedError`. The caller treated this as a regular
phase failure (`passed: false`, recorded in normal results), unlike
the load and chaos kinds which propagate abort via the throw path.

**Action taken:** throw `new ScenarioAbortedError()` at the entry-time
abort check. The post-`await` block already re-throws when the signal
fires mid-phase, so both abort paths are now consistent.

### [F-20] `updateLatencyMetrics` is dead code
**Severity:** low · **Status:** deferred (delete in a follow-up)
**Location:** `packages/simulation/engine/src/framework/execution/execution-engine.ts:84`

`run-load-window.ts` uses `LatencyTracker` exclusively and overwrites
all latency fields from the snapshot; nothing calls
`updateLatencyMetrics`. The function exists on the public surface
and could mislead future contributors who pattern-match off it.

**Action:** delete in a dedicated dead-code cleanup pass with `knip`
verification.

---

## Summary of this pass

- **Fixed** (8): F-1, F-2, F-4, F-5, F-14, F-17, F-18, F-19.
- **Deferred** (10): F-3, F-6, F-7, F-8, F-9, F-11, F-12, F-13, F-15, F-16, F-20.
- **Wontfix** (1): F-10 (not a defect on re-read).

Two of the fixed entries are critical (F-17 silently flipped pass/fail
on every simulation run; F-18 broke the abort contract for the load
loop). The rest are medium/low and span correctness, error handling,
and doc-drift.
