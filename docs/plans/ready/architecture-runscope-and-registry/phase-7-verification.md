# Phase 7: Verification

**Goal:** End-to-end validation that the T1+T2 refactor achieved its stated outcomes. Adds a SaaS-mode smoke test that constructs two `RunScope`s in one process and runs them concurrently. Quantifies the test-plumbing-deletion metric. Confirms the dogfood gate (`pnpm fit`) stays green.

**Depends on:** Phase 6 (all behavioural changes landed).

This phase is the PR E gate. It's small (one task per metric) but high-signal — the SaaS smoke test is the closest the codebase has come to validating the user-global "all features must work in both embedded and SaaS modes" invariant.

---

## Task 7.1: SaaS-mode concurrent-scope smoke test

**Files:**
- Create: `packages/cli/src/__tests__/saas-mode-smoke.test.ts`

**Context:** RunScope is supposed to make in-process concurrency safe. The simplest demonstration: `Promise.all([runWithScope(scopeA, runFit), runWithScope(scopeB, runFit)])` against two distinct fixture projects, verifying no state crossover.

**Steps:**

1. Set up two fixture project dirs (`/tmp/saas-a`, `/tmp/saas-b`) each with `opensip-tools.config.yml` + a couple of source files. The two projects should differ in checks selected, target globs, etc., so a state crossover would surface as a mismatched finding count or a wrong file path.

2. Test:

   ```typescript
   import { runWithScope, RunScope } from '@opensip-tools/core';
   import { runFit } from '@opensip-tools/fitness';

   it('two RunScopes run concurrently in one process without state crossover', async () => {
     const scopeA = new RunScope({ projectContext: ctxFor('/tmp/saas-a'), ... });
     const scopeB = new RunScope({ projectContext: ctxFor('/tmp/saas-b'), ... });

     const [resultA, resultB] = await Promise.all([
       runWithScope(scopeA, () => runFit({ recipe: 'quick-smoke', ... })),
       runWithScope(scopeB, () => runFit({ recipe: 'backend', ... })),
     ]);

     expect(resultA.summary.projectRoot).toBe('/tmp/saas-a');
     expect(resultB.summary.projectRoot).toBe('/tmp/saas-b');
     expect(resultA.findings).not.toMatchObject(resultB.findings);

     // Cleanup
     scopeA.dispose();
     scopeB.dispose();
   });
   ```

3. **Hardening:** add a parallel test with `runFit` simultaneously against fitness AND `runGraph` against graph, in two different scopes — exercises the engine-level orchestration across two tools concurrently. This is the closest-to-SaaS smoke we get without standing up an actual host.

**Observability:** Each `runFit` / `runGraph` emits its normal event stream into its scope's logger. The test asserts those streams are disjoint (a finding from `scopeA` doesn't appear in `scopeB.logger`'s captured output).

**Wiring:** Test-only.

**Error cases:** If the test fails, the most likely cause is a remaining module-level singleton that wasn't migrated. Phase 6 Task 6.6's grep cleanup should have eliminated these, but the test is the truth.

**Verification:**
```bash
pnpm --filter @opensip-tools/cli test src/__tests__/saas-mode-smoke.test.ts
```

**Commit:** `test(cli): SaaS-mode concurrent-scope smoke test`

---

## Task 7.2: Quantify test-plumbing-deletion metric

**Files:**
- Modify: this phase file's "Findings" section
- Modify: `docs/plans/architecture/2026-05-27-architecture-cross-cutting-recommendations.md` — add a "Resolution" pointer at the bottom

**Context:** The plan's acceptance criteria say: "Registry / lifecycle test plumbing LOC drops by ≥ 50%." This task measures and records.

**Steps:**

1. Before/after LOC of test-only resets, measured via:

   ```bash
   git log --oneline --grep="refactor(core): Registry" -1 --format='%H'  # the Phase 2 SHA
   ```

   Take the diff of `clearXForTesting`, `WithoutRegistration`, `clear*` helper-export deletions between Phase 1 baseline and current HEAD:

   ```bash
   git diff <phase-1-sha>..HEAD --stat -- 'packages/**/__tests__/**' 'packages/**/*WithoutRegistration*' \
     | tail -1
   ```

2. Record the absolute LOC removed and the percentage reduction.

3. Verify the original cross-cutting report's other quantitative claims:

   | Claim | Verification |
   |---|---|
   | "10 registry classes → 1 base + thin subclasses" | `find packages -name "registry.ts" \| xargs wc -l` shows total ≤ 600 LOC |
   | "5 duplicate policies → 1 closed union" | `grep "DuplicatePolicy" packages/core/src/lib/registry.ts` shows exactly the 5 listed |
   | "`SimulationRecipeRegistry` LSP violation gone" | `grep "this\.byId\|this\.byName" packages/simulation/engine/src/recipes/registry.ts` returns zero |
   | "`Symbol.for(globalThis)` slot removed" | grep returns zero (already verified by Phase 6 end-of-phase check) |

4. Update the cross-cutting report's "Notes" with a single line: `# Resolution`, `Implemented in docs/plans/ready/architecture-runscope-and-registry/. Phase 7 landed YYYY-MM-DD. Metrics: <test plumbing LOC removed>, <registry LOC reduction>.`

**Observability:** Documented in this file under "Findings."

**Verification:** The grep / `wc -l` commands above pass.

**Commit:** `docs(plans): record T1+T2 refactor metrics in cross-cutting report`

---

## Task 7.3: Confirm the dogfood gate stays green

**Files:**
- Run: `pnpm fit`
- Run: full CI matrix locally if possible

**Context:** The dogfood plan landed `pnpm fit` against opensip-tools itself in CI (per `docs/plans/ready/dogfood-fit-against-self/`). If the refactor regresses any of the dogfooded checks (new false positives, missed positives), we should know.

**Steps:**

1. `pnpm build && pnpm fit` from a clean tree on the merged main.
2. Inspect output for new violations vs the pre-refactor baseline. New violations should be either: (a) the refactor genuinely introduced a quality issue (fix it), or (b) a false positive the refactor exposed (file an issue against the relevant check). No third option.
3. Inspect the SARIF upload in GitHub Code Scanning if CI runs that — confirm no spurious alerts.

**Observability:** Fit run produces its normal structured-event stream + SARIF.

**Verification:** Exit code 0. Findings count ≤ pre-refactor baseline.

**Commit:** None — `pnpm fit` is observation, not a code change.

---

## Task 7.4: Update CLAUDE.md with the new RunScope conventions

**Files:**
- Modify: `CLAUDE.md` — add a "Per-run state lives on RunScope" section to the "Coding Standards" area.

**Context:** New conventions need a doc surface. The "no module-level mutable state in `cli-context.ts`" rule is exactly the kind of thing future contributors should not re-introduce.

**Steps:**

1. Add a short section under "Coding Standards":

   ```markdown
   ### Per-run state lives on `RunScope`

   - Per-CLI-invocation state (logger, caches, registries, datastore) lives
     on `RunScope`. Never reintroduce module-level mutable state for these
     concerns.
   - Tools read `cli.scope.foo`. The legacy `defaultToolRegistry` /
     `defaultLanguageRegistry` exports do not exist anymore.
   - `getCheckConfig(slug)` reads from the current scope via
     AsyncLocalStorage. It does NOT read from `globalThis`.
   - Registration of tools, languages, scenarios, recipes, and checks is
     ALWAYS explicit. `defineX(...)` returns a value; the caller registers
     it. No module-import side effects.
   ```

2. Add a one-line entry under "Layering rules":

   ```markdown
   - `Registry<T>` and `RunScope` live in `@opensip-tools/core`. Tools own
     their own thin subclasses; no per-tool registries leak to the kernel.
   ```

**Observability:** None.

**Wiring:** Documentation only.

**Verification:** `pnpm docs:check` (validates the architecture / web mirror is consistent).

**Commit:** `docs: per-run state convention + RunScope layering rule`

---

## End-of-phase verification

```bash
pnpm typecheck && pnpm test && pnpm lint
pnpm fit
pnpm --filter @opensip-tools/cli test src/__tests__/saas-mode-smoke.test.ts
```

Acceptance:

- [ ] SaaS-mode concurrent-scope smoke test exists and passes.
- [ ] Test-plumbing-deletion metric is ≥ 50% reduction in LOC for `clearXForTesting`, `WithoutRegistration` shapes, and resetter exports.
- [ ] Registry total LOC (across all `registry.ts` files in the workspace) is ≤ ~600 (down from ~1259 baseline per the cross-cutting audit).
- [ ] `SimulationRecipeRegistry`, `getCheckConfig`, simulation plugin loader, `lang-typescript filter`, `cli-context` no longer touch any module-level mutable state for the targeted concerns.
- [ ] `pnpm fit` (dogfood gate) green. No new false positives surfaced.
- [ ] CLAUDE.md documents the new conventions.
- [ ] The cross-cutting recommendations report has a "Resolution" note at the bottom pointing at this plan's completion.

---

## Findings

*(Task 7.2 fills this in during Phase 7 execution.)*
