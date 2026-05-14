# Phase 6: `@opensip-tools/lang-cpp` via clang-tidy CommandConfig

**Goal:** Support C++ via a fundamentally different path from the tree-sitter languages: shell out to `clang-tidy`. The C++ adapter declares itself as "command-only" — `parse()` returns `null` and the query API is undefined. Checks targeting C++ use `CommandConfig` mode (already supported in `packages/core/src/framework/check-config.ts` at line 259), not `analyze`.
**Depends on:** Phases 1 and 2

C++ is the one language where in-process parsing isn't realistic. Tree-sitter-cpp exists but C++ requires the preprocessor for anything beyond syntax-level checks. `clang-tidy` is the standard tool, ships its own AST, and has a mature check ecosystem. opensip-tools wraps it.

Task order: 6.1 (lang-cpp package) -> 6.2 (clang-tidy wrapper) -> 6.3 (checks-cpp passthrough check) -> 6.4 (CLI fixture + end-to-end test).

---

## Task 6.1: Create `@opensip-tools/lang-cpp` package

**Files:** [size: S]
- Create: `packages/lang-cpp/package.json`, `tsconfig.json`, `src/index.ts`, `src/adapter.ts`

**Context:** Mirror the Phase 3 Task 3.1 shape but with no `tree-sitter-*` deps. Dependencies: only `@opensip-tools/core`. The adapter declares C++ extensions but its `parse` always returns `null` — checks must use `CommandConfig` mode. This is a legitimate adapter shape, not a degenerate one: declaring the language with the registry lets file-target dispatch route `.cpp`/`.cc`/`.cxx`/`.hpp`/`.h` files to C++ checks.

**The `.h` ambiguity:** Both C and C++ headers use `.h`. opensip-tools doesn't ship a C adapter (out of scope for this plan). For now the C++ adapter claims `.h` too — if a future C adapter ships, the registry collision warning logged in Phase 0 Task 0.2 surfaces the conflict. A more nuanced solution (content-sniffing for C++-only syntax) is deferred.

**Steps:**

1. `packages/lang-cpp/package.json`:
   ```json
   {
     "name": "@opensip-tools/lang-cpp",
     "version": "0.6.1",
     "license": "MIT",
     "description": "C++ language adapter for opensip-tools (clang-tidy-backed)",
     "type": "module",
     "main": "./dist/index.js",
     "types": "./dist/index.d.ts",
     "scripts": { "build": "tsc", "test": "vitest run --passWithNoTests", "typecheck": "tsc --noEmit", "clean": "rm -rf dist" },
     "dependencies": { "@opensip-tools/core": "workspace:*" },
     "devDependencies": { "@types/node": "^22.0.0", "vitest": "^2.1.0" }
   }
   ```
2. `packages/lang-cpp/src/adapter.ts`:
   ```typescript
   import type { LanguageAdapter } from '@opensip-tools/core/languages/adapter.js'

   /**
    * C++ adapter — declarative-only. The in-process parse() returns null
    * because C++ requires the preprocessor; real analysis goes through
    * clang-tidy via CommandConfig-mode checks.
    *
    * The adapter exists so file-target dispatch can route C++ files to
    * C++-scoped checks. stripStrings/stripComments use simple regexes
    * (good enough for comment/string regex-based checks; precise analysis
    * uses clang-tidy directly).
    */
   export const cppAdapter: LanguageAdapter<null, null> = {
     id: 'cpp',
     fileExtensions: ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++', '.h'],
     aliases: ['c++', 'cxx'],
     parse: () => null,
     stripStrings: (content) => content.replace(/"(?:[^"\\]|\\.)*"/g, (m) => ' '.repeat(m.length)),
     stripComments: (content) =>
       content
         .replace(/"(?:[^"\\]|\\.)*"/g, (m) => ' '.repeat(m.length))
         .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
         .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length)),
   }

   export const adapters = [cppAdapter] as const
   ```

**Wiring:** Registered via `'lang'` plugin domain.

**Verification:**
```bash
pnpm --filter=@opensip-tools/lang-cpp build
```

**Commit:** `feat(lang-cpp): scaffold C++ adapter (declarative, no in-process parse)`

---

## Task 6.2: clang-tidy wrapper for CommandConfig

**Files:** [size: M]
- Create: `packages/lang-cpp/src/clang-tidy.ts`

**Context:** `CommandConfig` (`packages/core/src/framework/check-config.ts:135`) takes a `bin`, `args`, and a `parseOutput(stdout, stderr, exitCode, files, cwd)` function returning `CheckViolation[]`. Build a reusable wrapper that produces a `CommandConfig` configured for `clang-tidy` with a given set of checks. The parser converts clang-tidy's diagnostic output (lines like `path/to/file.cpp:42:5: warning: ...`) into `CheckViolation` objects.

clang-tidy can emit a YAML fixes file via the `-export-fixes=<file>` flag, which is more parseable than the line-based output. The wrapper writes that file to a tempdir and reads it after the run.

**Steps:**

1. `packages/lang-cpp/src/clang-tidy.ts`:
   ```typescript
   import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
   import { tmpdir } from 'node:os'
   import { join } from 'node:path'

   import type { CommandConfig, CheckViolation } from '@opensip-tools/core'

   export interface ClangTidyOptions {
     /** clang-tidy check names, e.g. ['modernize-use-nullptr', 'readability-*'] */
     readonly checks: readonly string[]
     /** Path to a compilation database directory (containing compile_commands.json). Optional. */
     readonly compilationDatabaseDir?: string
   }

   export function clangTidyCommand(options: ClangTidyOptions): CommandConfig {
     const tmpDir = mkdtempSync(join(tmpdir(), 'opensip-clang-tidy-'))
     const fixesFile = join(tmpDir, 'fixes.yaml')

     return {
       bin: 'clang-tidy',
       args: (files) => {
         const args: string[] = [
           `-checks=${options.checks.join(',')}`,
           `-export-fixes=${fixesFile}`,
         ]
         if (options.compilationDatabaseDir) args.push('-p', options.compilationDatabaseDir)
         args.push(...files)
         return args
       },
       parseOutput: (stdout, _stderr, _exitCode, _files, _cwd) => {
         const violations: CheckViolation[] = []
         // clang-tidy emits diagnostics on stdout in line-based form:
         //   /abs/path/file.cpp:LINE:COL: warning: message [check-name]
         // The wrapper parses stdout; the YAML fixes file is reserved for a later phase.
         const pattern = /^(.+?):(\d+):(\d+):\s+(warning|error):\s+(.+?)\s+\[([^\]]+)\]\s*$/gm
         let m: RegExpExecArray | null
         while ((m = pattern.exec(stdout)) !== null) {
           const [, file, line, col, severity, message, checkName] = m
           violations.push({
             filePath: file,
             line: parseInt(line!, 10),
             column: parseInt(col!, 10),
             message: `${message} [${checkName}]`,
             severity: severity === 'error' ? 'error' : 'warning',
             match: checkName,
           })
         }
         try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
         return violations
       },
       expectedExitCodes: [0, 1],  // clang-tidy returns 1 when diagnostics are found
     }
   }
   ```

**Wiring:** Consumed by `checks-cpp` (Task 6.3).

**Verification:**
```bash
pnpm --filter=@opensip-tools/lang-cpp build
```

Manual test (requires `clang-tidy` installed locally):
```bash
echo 'int main() { int* p = 0; return *p; }' > /tmp/x.cpp
clang-tidy -checks=modernize-use-nullptr /tmp/x.cpp
```
Should produce one diagnostic; if so, the regex in `parseOutput` covers it.

**Commit:** `feat(lang-cpp): clang-tidy CommandConfig wrapper`

---

## Task 6.3: Proof check — clang-tidy passthrough

**Files:** [size: S]
- Create: `packages/checks-cpp/package.json`, `tsconfig.json`, `src/index.ts`, `src/checks/clang-tidy-passthrough.ts`

**Context:** Define a check that runs a default set of clang-tidy modernize + readability checks and emits findings. Demonstrates `CommandConfig` mode end-to-end with the new language adapter.

**Steps:**

1. Scaffold `packages/checks-cpp/` mirroring `packages/checks-rust/` shape (Phase 3 Task 3.1).
2. `packages/checks-cpp/src/checks/clang-tidy-passthrough.ts`:
   ```typescript
   import { defineCheck } from '@opensip-tools/core'
   import { clangTidyCommand } from '@opensip-tools/lang-cpp'

   export const clangTidyPassthrough = defineCheck({
     id: 'e1f2a3b4-c5d6-7890-abcd-ef0123456789',
     slug: 'cpp-clang-tidy',
     description: 'Run clang-tidy with modernize + readability checks',
     scope: { languages: ['cpp'], concerns: ['backend'] },
     tags: ['quality', 'cpp'],
     fileTypes: ['.cpp', '.cc', '.cxx', '.hpp'],
     command: clangTidyCommand({
       checks: ['modernize-use-nullptr', 'modernize-use-auto', 'readability-braces-around-statements'],
     }),
     timeout: 60_000,
   })
   ```
3. Export from `src/index.ts`.

**Wiring:** Registered via `'fit'` plugin domain. When `clang-tidy` is not on PATH, the command fails — the command executor at `core/src/framework/command-executor.ts` surfaces that as an error result. Document the dependency in the package README.

**Verification:**
```bash
pnpm --filter=@opensip-tools/checks-cpp build
```

**Commit:** `feat(checks-cpp): clang-tidy passthrough check`

---

## Task 6.4: CLI fixture + end-to-end test

**Files:** [size: S]
- Create: `packages/cli/__fixtures__/multi-lang/sample.cpp`
- Create: `packages/cli/src/__tests__/multi-lang-cpp.test.ts`

**Context:** Same shape as Phase 3 Task 3.7. Fixture has one `.cpp` file that triggers `modernize-use-nullptr`. End-to-end test runs the pipeline against the fixture.

**Skip condition:** clang-tidy must be present on PATH. If not, the test must `skip` (not fail) — use `it.skipIf(!hasClangTidy())`. Verify with `which clang-tidy` in beforeAll.

**Steps:**

1. `sample.cpp`:
   ```cpp
   int main() {
       int* p = 0;
       return p != 0 ? *p : 0;
   }
   ```
2. End-to-end test asserting at least one violation contains `modernize-use-nullptr` in the match field.

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli test
```

**Commit:** `test(cli): end-to-end C++ fitness check via clang-tidy`

---

## Phase 6 End-to-End Verification

```bash
pnpm build && pnpm typecheck && pnpm test
```

Manual smoke:
```bash
which clang-tidy
cd packages/cli/__fixtures__/multi-lang
opensip-tools fit
```

Expected: when clang-tidy is installed, the report shows `cpp-clang-tidy` violations on `sample.cpp`. When it isn't, the check surfaces a command-execution error (handled gracefully by the result builder's `buildError`) and the rest of the run still completes.
