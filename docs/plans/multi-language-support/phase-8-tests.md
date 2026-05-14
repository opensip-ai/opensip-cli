# Phase 8: Tests

**Goal:** Cover the work in Phases 0-7 with unit and integration tests beyond the per-phase ones already added inline. Most of the load-bearing tests already live in their originating phase files (Phase 0 Task 0.4 registry, Phase 1 Task 1.5 parse cache + plugin domain, Phase 2 Task 2.7 TS adapter, Phase 3 Task 3.7 Rust end-to-end, Phase 4 Task 4.5 cross-language, Phase 5 each language's end-to-end, Phase 6 Task 6.4 C++, Phase 7 Task 7.4 migration regression). This phase fills gaps the per-phase tests didn't naturally cover.
**Depends on:** All implementation phases.

This phase is intentionally lean — it does NOT duplicate what's already covered above. It adds two specific tests that don't fit in any single phase: a cross-phase integration test, and a fail-loud test for misconfiguration.

---

## Task 8.1: Cross-phase integration test — all five languages registered, one fixture per language

**Files:** [size: M]
- Create: `packages/cli/src/__tests__/multi-lang-integration.test.ts`

**Context:** Per-phase tests verify each language pack works in isolation. This test verifies they all coexist: register typescript, rust, python, java, go, cpp adapters in the same process; await warmup for tree-sitter languages; run a single fit pipeline over a fixture directory containing one sample of each; assert that each file produces the expected violation count from its proof check.

This is the only test that exercises adapter-registry collision behavior (Phase 0 Task 0.4 covers it as a unit test; this is the integration form), the lazy-warmup ordering across multiple tree-sitter packs (Phase 3 + Phase 5), the `'lang'` plugin domain loading multiple packs (Phase 1 Task 1.5 covers a single pack), and the per-file dispatch to the right adapter via `defaultLanguageRegistry.forFile()` under realistic conditions.

**Steps:**

1. Create the test file with a structure mirroring Phase 3 Task 3.7's `multi-lang-rust.test.ts`:
   ```typescript
   import { describe, it, beforeAll, expect } from 'vitest'

   import { defaultLanguageRegistry } from '@opensip-tools/core/languages'
   import { defaultRegistry } from '@opensip-tools/core'
   import { typescriptAdapter } from '@opensip-tools/lang-typescript'
   import { rustAdapter } from '@opensip-tools/lang-rust'
   import { pythonAdapter } from '@opensip-tools/lang-python'
   import { javaAdapter } from '@opensip-tools/lang-java'
   import { goAdapter } from '@opensip-tools/lang-go'
   import { cppAdapter } from '@opensip-tools/lang-cpp'

   import { noUnwrap } from '@opensip-tools/checks-rust'
   import { noBareExcept } from '@opensip-tools/checks-python'
   import { noSystemOutPrintln } from '@opensip-tools/checks-java'
   import { noFmtPrintln } from '@opensip-tools/checks-go'

   describe('multi-language integration', () => {
     beforeAll(async () => {
       defaultLanguageRegistry.clear()
       defaultLanguageRegistry.register(typescriptAdapter)
       defaultLanguageRegistry.register(rustAdapter)
       defaultLanguageRegistry.register(pythonAdapter)
       defaultLanguageRegistry.register(javaAdapter)
       defaultLanguageRegistry.register(goAdapter)
       defaultLanguageRegistry.register(cppAdapter)
       await Promise.all([
         rustAdapter.warmup?.(),
         pythonAdapter.warmup?.(),
         javaAdapter.warmup?.(),
         goAdapter.warmup?.(),
       ])
       defaultRegistry.register(noUnwrap)
       defaultRegistry.register(noBareExcept)
       defaultRegistry.register(noSystemOutPrintln)
       defaultRegistry.register(noFmtPrintln)
     })

     it('dispatches each fixture to its language adapter and finds the expected violation', async () => {
       // Run the fit pipeline against packages/cli/__fixtures__/multi-lang/
       // Assert that each per-language proof check produces exactly the expected
       // violation count on its own fixture file.
     })

     it('does not dispatch a Rust check against a Python file', async () => {
       // Negative test — fileTypes + scope filtering prevents cross-language mis-dispatch
     })
   })
   ```
2. The actual pipeline invocation goes through the same code path the CLI uses. Find the entry point (likely `packages/cli/src/commands/fit.ts` or similar; verify by grep) and call its function directly with a config that points to the fixture dir.

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli test multi-lang-integration
```

**Commit:** `test(cli): cross-language integration with five adapters registered`

---

## Task 8.2: Fail-loud test for unknown-language target

**Files:** [size: S]
- Create: `packages/core/src/targets/__tests__/unknown-language.test.ts`

**Context:** When `opensip-tools.config.yml` declares `languages: ['kotlin']` but no Kotlin adapter is registered, the project state is misconfigured. Two behaviors are defensible: (a) silently skip Kotlin targets, (b) fail loud with a clear error. Per the user's design directive (config-driven adapter loading + clear error), this test asserts (b).

**Steps:**

1. Read the existing target loader test patterns under `packages/core/src/targets/__tests__/`. Mirror the fixture-driven style.
2. Create a test that:
   - Loads a config with a target declaring `languages: ['kotlin']`.
   - Does NOT register a Kotlin adapter.
   - Asserts that the loader (or a later validator) emits an error mentioning `kotlin` and the target name.
3. **Caveat:** the existing loader at `packages/core/src/targets/loader.ts` does not currently cross-check declared languages against registered adapters. This test reveals that gap; implementing the validation is a follow-up. Mark this test `it.todo(...)` if implementing the validator is out of scope here, OR add a minimal validator pass as part of this task (preferred — it's a few lines).

**Steps for the validator:** Add a function to `packages/core/src/targets/loader.ts` (export it from `targets/index.ts`):
```typescript
export function validateTargetLanguages(
  targets: readonly Target[],
  registry: LanguageRegistry,
): readonly string[] {
  const errors: string[] = []
  for (const target of targets) {
    const langs = target.config.languages ?? []
    for (const lang of langs) {
      if (!registry.has(lang)) {
        errors.push(`Target "${target.config.name}" declares language "${lang}" but no adapter is registered`)
      }
    }
  }
  return errors
}
```
Wire this into the CLI bootstrap (after adapter registration, before checks run) so the failure surfaces at startup.

**Verification:**
```bash
pnpm --filter=@opensip-tools/core test unknown-language
```

**Commit:** `feat(core)+test: fail loud when targets declare unregistered languages`

---

## Phase 8 End-to-End Verification

```bash
pnpm test
```

All tests across the workspace pass. The cross-language integration test specifically completes in under 10 seconds — if it's much slower, the warmup parallelization is broken (warmups should run concurrently, not serially).
