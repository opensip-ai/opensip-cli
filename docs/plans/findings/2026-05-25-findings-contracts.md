# 2026-05-25 — Findings: `@opensip-tools/contracts`

Bug & correctness audit of the contract types + persistence layer. Auditor: `feature-dev:code-reviewer` agent. Fixes applied in the same pass.

## Findings

### 1. Unsafe runtime cast on `row.summary` (HIGH, fixed)

**File:** `src/persistence/session-repo.ts` (`hydrateSession`)

**Issue:** The session `summary` column is declared with `mode: 'json'` — drizzle deserializes it as `unknown`, and the code did `row.summary as SessionSummary`. There was no runtime validation. A legacy or hand-edited row missing any of the five required fields (`total`, `passed`, `failed`, `errors`, `warnings`) would silently surface as `undefined` to downstream consumers, breaking history rendering and gate comparison without an error.

**Fix:** Added `isSessionSummary` type guard. `hydrateSession` now throws an explicit error when the stored summary blob does not match the expected shape, so corrupt rows surface immediately rather than poisoning later computations.

### 2. Unsafe runtime cast on `row.tool` (HIGH, fixed)

**File:** `src/persistence/session-repo.ts` (`hydrateSession`)

**Issue:** The `tool` column is `text('tool').notNull()` — no SQLite CHECK constraint, no Drizzle enum. The code blindly cast `row.tool as StoredSession['tool']` (a `'fit' | 'sim' | 'graph'` union), so a row containing any other string would violate the type at runtime while TypeScript believed it was sound. Branches like `if (session.tool === 'fit')` could silently misroute.

**Fix:** Added `VALID_TOOLS` set + `isValidTool` type guard. `hydrateSession` validates `row.tool` against the union and throws with the offending value when it doesn't match.

### 3. Recipe-not-found mis-routed to CHECK_NOT_FOUND exit code (MEDIUM, fixed)

**File:** `src/exit-codes.ts` (`SUGGESTION_RULES`)

**Issue:** The check-not-found rule applied two regex patterns in sequence (`/Check not found: (.+)/` and the broader `/not found: (.+)/`). The fitness engine throws `Recipe not found: <id>` from `recipes/service.ts:105`, which matches the broader regex first and returned `EXIT_CODES.CHECK_NOT_FOUND` (3) when it should return `EXIT_CODES.CONFIGURATION_ERROR` (2). CI scripts that gate on exit codes (2 = "fix your config", 3 = "fix your invocation") would mishandle recipe errors. The existing test in `exit-codes.test.ts` documented the wrong behavior as correct.

**Fix:** Added a dedicated recipe-not-found rule ahead of the check-not-found rule. It captures the slug from `Recipe not found: <id>` and routes to `CONFIGURATION_ERROR`. Updated the test: the `"Recipe not found: my-recipe"` case now expects `CONFIGURATION_ERROR`; the bare check-not-found case was rewritten to use a real check slug (`not found: foo-check`).

### 4. N+1 reads in `hydrateSession` outside any transaction (MEDIUM, fixed)

**File:** `src/persistence/session-repo.ts` (`hydrateSession`)

**Issue:** `list()` iterated session rows, and for each row `hydrateSession` issued one SELECT for checks and one SELECT per check for findings — all on the live `db` handle, never under a transaction. A concurrent writer could insert/delete findings between the check-row fetch and the per-check finding fetch, producing phantom or missing findings within the same session snapshot.

**Fix:** The check-and-finding hydration is now wrapped in `datastore.transaction(...)`, which uses SQLite's snapshot isolation for read transactions.

### 5. `score` column declared `integer` but `StoredSession.score` typed `number` (MEDIUM, not fixed — documented)

**File:** `src/persistence/schema/sessions.ts`

**Issue:** The schema stores `score` as `integer`. The producer (fitness engine, `recipes/service.ts:294`) explicitly calls `Math.round` so the value is always an integer at write time. The interface, however, types it as `number` without that constraint — a future producer that omitted the round would have its fractional score silently truncated.

**Decision:** Deferred. The truncation is not currently realized (the only producer rounds), and changing the column to `real` requires a migration with associated risk. Documented here so a future producer change can decouple. If a real-valued score is ever introduced, the fix is two-line: change the column type and add a migration.

## Verification

- `pnpm typecheck` clean
- `pnpm --filter=@opensip-tools/contracts test` passing, including the corrected exit-code test case
- `pnpm lint` clean
