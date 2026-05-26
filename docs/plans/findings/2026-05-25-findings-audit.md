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
**Severity:** n/a · **Status:** wontfix (not a defect — synchronous)
**Location:** `packages/fitness/engine/src/recipes/service.ts:275`,
same file `:176`

The audit sub-agent flagged these as Promise-discards. On re-read,
`initParseCache` and `clearParseCache` in
`@opensip-tools/core/languages/parse-cache.js` are **synchronous and
return `void`**. The `void` prefix is just an explicit-discard
annotation (often used to satisfy lint rules on bare expression
statements), not a discarded Promise. No defect.

### [F-8] `scope-resolver.ts` mutates `Set` while iterating it
**Severity:** low (per-spec safe, fragile) · **Status:** fixed
**Location:** `packages/fitness/engine/src/framework/scope-resolver.ts:43-47`

The forward-iteration delete-during-`for…of` pattern is defined
behavior for `Set` per ECMA-262, so this is not a correctness defect
today. It is fragile: any refactor that converts the loop body or
moves the deletion through another helper could silently break it.

**Action taken:** replaced the mutation loop with
`[...files].filter(...).sort()` — clearer semantics, equivalent
output, no spec-corner reliance.

### [F-9] `checksLoaded` module-level singleton never resets
**Severity:** low (only bites long-lived hosts) · **Status:** fixed
**Location:** `packages/fitness/engine/src/cli/fit.ts:65-66, 140-205`

A second `executeFit(...)` call in the same process — possible from a
long-running daemon, programmatic API, or back-to-back test cases —
skipped plugin loading because the module-level `checksLoaded` flag
stayed true. Today the CLI is one-shot per process, but a single
`ensureChecksLoaded` against a different project root must re-discover
the plugin set anchored at that root.

**Action taken:** replaced the boolean `checksLoaded` with a
`checksLoadedFor: string | null` keyed on the project directory (empty
string is the sentinel for "no projectDir"). A call with a different
key re-runs the full plugin + check-package discovery.

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
**Severity:** medium (Windows only) · **Status:** fixed
**Location:** `packages/graph/engine/src/cli/orchestrate.ts:559`

`closureAbs.add(`${projectDirAbs}/${dep}`.split('/').join(sep))`
hard-concatenates with `/` then replaces `/` with `path.sep`. On
Windows, `projectDirAbs` already contains backslashes that pass
through unchanged, yielding a mixed-separator path that never matches
entries in `discovery.files`. Incremental closure silently produces an
empty intersection and changed files are skipped.

**Action taken:** swapped the string-concat+split/join chain for
`join(projectDirAbs, dep)` from `node:path`. The previous code already
worked on POSIX (separator-replace was a no-op when sep was `/`), and
`join` produces the same result on POSIX while doing the right thing
on Windows. The `sep` import is retained — it's still used for the
inverse normalization at line 507.

### [F-12] `alwaysThrowsBranchRule` regex never matches real call-edge text
**Severity:** medium (rule never fires on real code) · **Status:** deferred (needs walker change + new fixture)
**Location:** `packages/graph/engine/src/rules/always-throws-branch.ts:43`
+ `packages/graph/graph-typescript/src/walk.ts:157-159`
+ `packages/graph/graph-typescript/src/edges.ts:53-59`

Confirmed defect after tracing the data path:
1. `walk.ts:157-159` pushes a call-site record for any node where
   `isResolverCandidate(node)` is true — that returns true for
   `NewExpression` (line 275) but never branches on the parent
   `ThrowStatement`. The `node` recorded is the `NewExpression`.
2. `edges.ts:tsPosition` computes the edge text as
   `sourceFile.text.slice(node.getStart(), node.getEnd())` — which is
   exactly `new Error(...)` for a `throw new Error(...)` statement.
   No `throw` prefix.
3. `THROW_SYNTAX_REGEX = /\bthrow\s+(?:new\s+)?[A-Za-z_$]/` requires
   the word "throw" somewhere in the text. It is never present.
4. The fallback `TYPESCRIPT_FALLBACK_THROW_REGEX` is identical in
   intent: requires `^\s*throw\s+`.

The Python and Rust regexes (`\braise\b`, `\bpanic!\s*\(`) work for
those languages only if the adapter records the enclosing `raise` /
`panic!` text — same caveat applies, needs per-adapter audit. The
integration test `rule-hints-integration.test.ts` constructs synthetic
`CallEdge`s with text like `'throw new Error("hi")'` via the `edge`
helper, which masks the walker's real output. The test passes; the
rule never fires in production.

**Action:** in `walk.ts`, when pushing a `'call'` record for a
`NewExpression` (or `CallExpression`) whose parent is a
`ThrowStatement`, record the throw statement's node instead so the
text slice includes the `throw ` prefix. Add a new
`rule-hints-integration` fixture that runs the actual walker against
real source text and asserts the rule fires. Same shape for Python's
`raise` and Rust's `panic!` if the symmetric defect is confirmed.
Deferred this pass: the walker change has cascading risk on edge
positions (line/column for every throw-shaped edge would change),
and the right fix needs a dedicated PR with adapter-by-adapter
tests.

### [F-13] `no-side-effect-path` false positive on unresolved edges
**Severity:** medium · **Status:** fixed
**Location:** `packages/graph/engine/src/rules/no-side-effect-path.ts:108-128`

`hasDiscardedCaller` looped `caller.calls`, skipping any edge whose
`to` did not include `occ.bodyHash`. When the loop found no matching
edge (stale index / unresolved catalog), `sawDiscardedField` stayed
false and the function returned `!false = true`, signalling a
discarded-result caller that did not exist. Mixed incremental
catalogs and unresolved edges triggered this — produced false-positive
no-side-effect-path signals.

**Action taken:** introduced a `sawMatchingEdge` boolean. The legacy
fallback (`!sawDiscardedField`) only applies when at least one
matching edge was actually observed; if no edge resolved to the
occurrence, the function returns `false` directly. Existing graph
suite (165 tests) continues to pass.

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
**Severity:** low (doc/behavior mismatch) · **Status:** fixed (doc only)
**Location:** `packages/languages/lang-typescript/src/ast-utilities.ts:40-46`

`walkNodes(root, visitor)` calls `ts.forEachChild(root, visit)` — the
root is never passed to the visitor, which contradicted the
"all nodes in a SourceFile or subtree" JSDoc. Sixty+ TS checks rely
on the current behavior, so changing it would risk a wide-blast
regression.

**Action taken:** updated the JSDoc to accurately describe the
current behavior — "walks every descendant of `root` (the root
itself is not visited)" — and documented the wrap pattern for callers
that need the root in their visitor. No behavior change.

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
**Severity:** n/a · **Status:** wontfix (not dead — exported public API)
**Location:** `packages/simulation/engine/src/framework/execution/execution-engine.ts:84`

The audit sub-agent flagged this as unused by the load-window loop.
On re-check it is **re-exported from `packages/simulation/engine/src/index.ts:173`**
(the package's public barrel), has its own test suite in
`__tests__/execution-engine.test.ts`, and appears in the package's
`dist/index.d.ts`. Removing it would be a breaking change to the
public API. Not a defect; not dead code.

---

## Summary across passes

- **Fixed** (13): F-1, F-2, F-4, F-5, F-8, F-9, F-11, F-13, F-14, F-15, F-17, F-18, F-19.
- **Deferred** (4): F-3, F-6, F-12, F-16.
- **Wontfix on re-read** (3): F-7, F-10, F-20.

The two critical fixes (F-17 inverted pass/fail on every sim run;
F-18 broke abort propagation in the load loop) were the high-impact
wins of this audit. F-9 (project-keyed plugin loading) tightens an
invariant before the fitness engine grows a long-lived host. F-15
was a docs-only correction after concluding the behavior change was
too wide-blast for a one-shot audit.

Remaining deferred items each need work that exceeds an in-audit
patch — dedicated PR with test-first scaffolding:

- F-3  schema generic — no current victim, latent design limitation.
       Worth doing when a consumer (fitness session repo, simulation
       state, graph catalog) is ready to bind a drizzle schema.
- F-6  parallel-execution Promise has no reject path — needs an abort/
       reject test fixture in the recipe execution suite before
       rewriting the driver. No exploit path today because
       `runOneCheck` is async-only and its `.finally` does only counter
       arithmetic, but a future change to either could expose it.
- F-12 always-throws rule's regex never matches real walker output —
       fix lives in the per-adapter walker (record `ThrowStatement`
       text not the inner `NewExpression`); the integration test
       suite needs a fixture that drives real source text through the
       walker (today's fixtures hand-construct `CallEdge`s with
       fake text). The walker change is also wide-blast: edge
       line/column positions would shift for every throw-shaped
       edge. Best done as a dedicated PR per adapter.
- F-16 filterContent cache memory — design issue, needs a signature
       change to take `filePath` and key on a compact fingerprint,
       touching every TS-AST check that calls stripStrings /
       stripComments. Memory pressure only, no correctness defect.
