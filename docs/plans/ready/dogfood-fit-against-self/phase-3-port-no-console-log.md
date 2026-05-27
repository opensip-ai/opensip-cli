# Phase 3: Port `no-console-log` as a project-local check

**Goal:** Add a project-local check that flags `console.{log,error,warn,info,debug}` in production code, excluding the legitimate console callers (logger module + cli-ui Ink components). The check lives in this repo only — it is **not** shipped via `@opensip-tools/checks-typescript`. Independent PR.
**Depends on:** Phase 0

The allowlist of legitimate console callers is opensip-tools-shaped (specific paths). Without a configurable-allowlist design in the check pack, this check is only useful here. Project-local is the right home until that design lands.

**Authoring constraint:** project-local checks are auto-discovered as `.mjs` or `.js` files (see `packages/core/src/plugins/discover.ts:266`: `LOOSE_FILE_EXTENSIONS = new Set(['.js', '.mjs'])`). TypeScript files are NOT picked up. The source check we're porting is `.ts`; we rewrite as `.mjs`.

---

## Task 3.1: Identify the legitimate console-call sites

**Files:**
- Modify: none (audit task; findings recorded inline below)

**Context:** Before writing the check, list every file in opensip-tools that legitimately calls `console.*`. The check's hardcoded allowlist must include exactly these paths.

**Steps:**

1. Audit:
   ```bash
   grep -rn "console\." packages/ --include="*.ts" --include="*.tsx" \
     | grep -v "__tests__/" | grep -v "\.test\.ts" \
     | grep -v "\.d\.ts" \
     | grep -v "node_modules"
   ```
2. Categorize each hit:
   - **Logger implementation** (`packages/core/src/lib/logger.ts`) — legitimate. The logger module wraps console internally.
   - **CLI-UI components** (`packages/cli-ui/src/**`) — Ink internals that need stdout access.
   - **CLI dispatcher pre-bootstrap** (rare; before the logger is constructed) — verify file path if any exist.
   - **Genuine violations** — these are what the check should catch.

3. Record the allowlist below. The allowlist is a set of **path substrings** the check tests via `filePath.includes(segment)`.

**Observability:** N/A — audit task.

**Wiring:** Findings feed Task 3.2's `ALLOWED_PATH_SEGMENTS` constant.

**Error cases:** N/A.

**Verification:**
```bash
grep -rn "console\." packages/ --include="*.ts" | grep -v "test" | grep -v "\.d\.ts" | wc -l
```

**Commit:** No commit — audit notes recorded in this phase file.

### Allowlist (Task 3.1 findings)

Audit of `grep -rn "console\.(log|error|warn|info|debug)\s*(" packages/`
across all production `.ts`/`.tsx` files (excluding tests, dist, and
node_modules) yielded **one** call site:

- `packages/fitness/engine/src/framework/execution-context.ts:226` —
  `console.log` inside a verbose check-level debug helper, already
  exempted via inline `@fitness-ignore-next-line no-console-log` pragma.

No other production console calls exist in this codebase. The
hypothesized allowlist paths (`packages/core/src/lib/logger.ts`,
`packages/cli-ui/src/`) contain ZERO console calls — opensip-tools uses
its structured Pino logger everywhere and Ink does its own stdout writes
internally (without calling `console.*` from our code).

The project-local `dogfood-no-console-log` check therefore needs only a
narrow allowlist — the file-ignore directive on the single exempt site
is sufficient. The check still implements path-substring allowlist
support so future call sites that legitimately need console (e.g.,
boot-time logging before the structured logger is wired) can be added
without code change.

### Genuine violations to address before merging

**None.** The audit found zero un-pragmaed console calls in production
code. The new check passes cleanly on a fresh run; no source-file
fixes are needed in this phase.

---

## Task 3.2: Write the project-local check

**Files:**
- Create: `opensip-tools/fit/checks/no-console-log.mjs`

**Context:** Source at `~/Documents/Code/opensip-ai/opensip/opensip-tools/fit/checks/quality/no-console-log.ts` (103 lines of TS). We rewrite as ES-module JS using only constructs that work without TS:

- Drop `import type` statements.
- Drop `interface` / `type` aliases (use JSDoc comments if helpful).
- Use named imports from `@opensip-tools/fitness` (the published package; in this monorepo it resolves via workspace linkage).
- Module shape: `export const checks = [defineCheck({...})]` — the expected discovery contract per `packages/core/src/plugins/__tests__/discover.test.ts:70`.

The check logic itself is identical to the source: regex over per-line content after masking comments/strings, scoped to TS files outside the allowlist.

**Steps:**

1. Read the source file at `~/Documents/Code/opensip-ai/opensip/opensip-tools/fit/checks/quality/no-console-log.ts`.
2. Create the directory: `mkdir -p opensip-tools/fit/checks`.
3. Create `opensip-tools/fit/checks/no-console-log.mjs` with this structure:

   ```javascript
   // opensip-tools/fit/checks/no-console-log.mjs
   //
   // Project-local: flags console.{log,error,warn,info,debug} in production
   // TypeScript code, excluding the logger module and cli-ui Ink components.
   //
   // Allowlist is opensip-tools-specific and hardcoded — if this pattern
   // proves valuable to other consumers, promote to first-party in
   // @opensip-tools/checks-typescript with a configurable allowlist.

   import { defineCheck, isTestFile, stripStringsAndComments } from '@opensip-tools/fitness'

   const CHECK_ID = '<fresh-uuid>'  // run uuidgen and paste

   const CONSOLE_PATTERN = /\bconsole\s*\.\s*(log|error|warn|info|debug)\s*\(/g

   // Path substrings (tested via filePath.includes(segment)) where
   // direct console use is the implementation, not a violation.
   const ALLOWED_PATH_SEGMENTS = [
     '/packages/core/src/lib/logger.ts',
     '/packages/cli-ui/src/',
     // ...other paths from Task 3.1 audit
   ]

   const FILE_IGNORE_RE = /@fitness-ignore-file\s+no-console-log/

   function isCliPath(filePath) {
     return filePath.includes('/packages/cli/src/')
   }

   /** @returns {Array<{line: number, message: string, severity: 'error' | 'warning', suggestion?: string}>} */
   export function analyzeNoConsoleLog(content, filePath) {
     if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) return []
     if (filePath.endsWith('.d.ts')) return []
     if (isTestFile(filePath)) return []
     if (ALLOWED_PATH_SEGMENTS.some((seg) => filePath.includes(seg))) return []
     if (!content.includes('console')) return []

     const rawLines = content.split('\n')
     if (rawLines.slice(0, 50).some((line) => FILE_IGNORE_RE.test(line))) return []

     const stripped = stripStringsAndComments(content)
     const lines = stripped.split('\n')

     const violations = []
     for (let i = 0; i < lines.length; i++) {
       const line = lines[i] ?? ''
       CONSOLE_PATTERN.lastIndex = 0
       let m
       while ((m = CONSOLE_PATTERN.exec(line)) !== null) {
         const method = m[1]
         violations.push({
           line: i + 1,
           message: `Found console.${method}( — production code must use the structured logger from @opensip-tools/core. See packages/core/src/lib/logger.ts.`,
           severity: 'error',
           suggestion: isCliPath(filePath)
             ? 'Use the CLI output helpers from packages/cli-ui (Ink renderers); never raw console.log in CLI surface code.'
             : 'Use logger from @opensip-tools/core: logger.info({ evt: \'<domain>.<component>.<action>\', msg: \'...\' }).',
         })
       }
     }
     return violations
   }

   const noConsoleLogCheck = defineCheck({
     id: CHECK_ID,
     slug: 'no-console-log',
     description: 'Production code must use the structured logger (@opensip-tools/core) — not console.log/error/warn/info/debug. Project-local check.',
     tags: ['quality', 'logging', 'observability'],
     fileTypes: ['ts', 'tsx'],
     scope: {
       languages: ['typescript'],
       concerns: ['backend', 'cli', 'observability'],
     },
     confidence: 'high',
     contentFilter: 'raw',
     analyze: analyzeNoConsoleLog,
   })

   // Discovery contract: project-local files export `checks: Check[]`.
   // See packages/core/src/plugins/__tests__/discover.test.ts:70.
   export const checks = [noConsoleLogCheck]
   ```

4. Generate the UUID: `uuidgen` (lowercase) and paste into `CHECK_ID`.

5. Apply the allowlist from Task 3.1's findings.

**Observability:** The fitness engine logs the check's invocation and any violations it returns via its existing Pino events. No new instrumentation in this file.

**Wiring:** The file is auto-discovered by the project-local plugin loader (per `packages/core/src/plugins/discover.ts`). After this file lands and the next `pnpm fit` run, the check appears in `fit-list` and runs as part of the default recipe. **No barrel re-export. No display registry entry.** The check shows in dashboard output under its raw slug (`no-console-log`) since project-local checks bypass the pack-level display registry — accepting this as the trade-off of project-local.

**Error cases:**
- Returns `[]` for files outside the analyzable set (non-TS, d.ts, tests, allowlisted, no `console` substring). No throw.
- File-ignore directive returns `[]`.
- No throw paths in the body — pure regex + string operations over text.
- If the `.mjs` is malformed (syntax error), the plugin loader logs a parse error per `packages/core/src/plugins/loader.ts`'s error handling and continues. The check is silently absent until fixed — `fit-list` would NOT show it. **Verify with Task 3.4.**

**Verification:**
```bash
# Confirm the file is discovered:
pnpm build
node packages/cli/dist/index.js fit-list 2>&1 | grep "no-console-log"
# Expect: one line showing the check.
```

**Commit:** `feat(fit): project-local no-console-log check`

---

## Task 3.3: Fix the genuine violations identified in Task 3.1

**Files:**
- Modify: each file Task 3.1's audit identified as a genuine violation.

**Context:** Project-local checks fire immediately — there's no baseline-and-ratchet for them like there is for the SQLite-backed first-party checks (and even that ratchet is broken in CI, see Phase 0). So before merging, the violations the new check finds must either be fixed OR pragmaed away (`// @fitness-ignore-file no-console-log` at file top with explanation in the PR description).

**Steps:**

1. For each violating file from Task 3.1:
   - **Preferred:** replace `console.<method>` with the structured logger or the cli-ui equivalent.
   - **If the call is legitimate but doesn't fit the hardcoded allowlist:** evaluate adding the path to `ALLOWED_PATH_SEGMENTS` in Task 3.2 instead. Each addition needs a justification comment.
   - **If genuinely unavoidable (e.g., bootstrap code before the logger exists):** add `// @fitness-ignore-file no-console-log -- <reason>` at file top.

2. Run `pnpm fit --check no-console-log` after each fix to confirm violations drop.

**Observability:** The structured logger replacement (where used) emits `evt:`-shaped events that flow through Pino. This is an observability *improvement* over the pre-existing `console.*` calls, which were unstructured.

**Wiring:** Code change. The logger module is already wired (existing imports under `@opensip-tools/core`).

**Error cases:** Replacing `console.error` with `logger.error` changes the output sink (was: stderr; now: structured logger's transport). Verify no log-capture code (e.g., test harnesses that capture stderr) relies on the old behavior. If something breaks, that's a finding — file it; don't add a band-aid `console.error` back.

**Verification:**
```bash
pnpm build && pnpm typecheck && pnpm test
pnpm fit --check no-console-log
# Expect: zero violations after Task 3.3 completes.
```

**Commit:** Group with Task 3.2 in the same PR. Suggested message: `fix: replace console.* with structured logger in production code`.

---

## Task 3.4: Integration test the project-local check

**Files:**
- Create: `opensip-tools/fit/checks/__tests__/no-console-log.test.mjs` (or integrate into Phase 4's `dogfood-integration.test.ts`)

**Context:** Project-local checks aren't tested through the pack's Vitest config by default. Two options:

- **(A)** Add a small Vitest config under `opensip-tools/fit/checks/` so this directory's `.test.mjs` files are picked up.
- **(B)** Skip the standalone test and rely on Phase 4's `dogfood-integration.test.ts` for coverage — that test runs `pnpm fit` against a fixture and would catch correctness issues.

**Recommended: (B)** — adding a Vitest config for one project-local file is overkill. Phase 4 already plans an integration test that exercises both new checks (`no-focused-tests` AND `no-console-log`). Lean on it.

**Steps:**

1. Confirm Phase 4's integration test (`packages/fitness/checks-typescript/src/__tests__/dogfood-integration.test.ts`) is the test surface for this check.
2. Add an assertion in that file that the project-local `no-console-log` check is discovered and fires correctly. The integration test must:
   - Programmatically load `opensip-tools/fit/checks/no-console-log.mjs` (via the discovery mechanism).
   - Run `analyzeNoConsoleLog` directly against fixture content.
   - Assert violations match expectations.
3. The actual test cases live in Phase 4's task list — Phase 4 file gets updated to add `no-console-log` cases.

**Observability:** Integration test pass/fail via Vitest output.

**Wiring:** Test runs as part of `pnpm test` via Phase 4's integration test file.

**Error cases:** If the integration test can't load the `.mjs` (path resolution issue, import error), the test fails loudly — investigate, don't paper over.

**Verification:**
```bash
pnpm test  # includes Phase 4's dogfood-integration test
```

**Commit:** Same PR as Task 3.2 if practical, or Phase 4's PR if Phase 4 ships separately.

---

## Phase 3 End-to-End Verification

After all four tasks:

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint
node packages/cli/dist/index.js fit-list | grep "no-console-log"
# Confirm the check appears (as raw slug since no display entry).

pnpm fit --check no-console-log
# Expect zero violations (after Task 3.3 fixes them all).

ls opensip-tools/fit/checks/no-console-log.mjs
# Confirm the file exists at the expected project-local path.
```

Phase 3 is complete when (a) the check appears in `fit-list`, (b) running it in isolation produces zero violations (no false positives after Task 3.3 cleanup), (c) the integration test (Phase 4) covers it, and (d) `pnpm lint` passes — note that `.mjs` files are not lint-targeted by the existing ESLint config (`"lint": "eslint 'packages/**/src/**/*.{ts,tsx}'"` per `package.json:13`), so verify there's nothing the linter would catch.

### Project-local properties (per `opensip-tools/fit/checks/README.md`)

Both Phase 2 and Phase 3 checks live project-local for the same reason: `opensip-tools/fit/checks/` doubles as documentation-by-example for plugin authors browsing the open-source repo. The known properties of project-local checks:

- **No display name/icon** — dashboard shows raw slug (`no-console-log`) instead of pretty form. Acceptable.
- **No first-party unit test** — coverage comes from Phase 4's integration test.
- **`.mjs` constraint** — no TypeScript niceties; JSDoc types only. Tolerable for a 100-line regex check.
- **Hardcoded allowlist** — specific to opensip-tools paths. Other consumers who want this check would copy the file and edit the constants. A configurable-allowlist first-party version is a follow-up plan candidate.

If a project-local check proves valuable to multiple opensip-tools consumers, the promotion path is documented in `opensip-tools/fit/checks/README.md` ("Promoting to first-party"). For now, accept these as features of the project-local pattern, not costs.
