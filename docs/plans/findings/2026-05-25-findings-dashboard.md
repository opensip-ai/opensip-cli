# 2026-05-25 — Findings: `@opensip-tools/dashboard`

Bug & correctness audit of the HTML report generator. Auditor: `feature-dev:code-reviewer` agent. Fixes applied in the same pass.

## Findings

### 1. `editorProtocol` literal serialization missing `escapeForScriptContext` (HIGH, fixed)

**File:** `src/generator.ts` (`serializeOptionalBlob`, `literal` arm)

**Issue:** The `'literal'` arm of `serializeOptionalBlob` called `JSON.stringify(value)` without subsequently calling `escapeForScriptContext`. `JSON.stringify` does escape `"`, `\`, and U+2028/U+2029, but NOT `<`. A string value containing the literal sequence `</script>` would close the surrounding inline `<script>` block — and `editorProtocol` is caller-controlled (sourced from `opensip-tools.config.yml`). The corresponding `'json'` arm already called `escapeForScriptContext`; the literal arm was an inconsistency.

**Fix:** Mirror the `'json'` arm: pipe `JSON.stringify(value)` through `escapeForScriptContext` before interpolating.

### 2. `latest.score` interpolated into `<title>` without coercion (MEDIUM, fixed)

**File:** `src/generator.ts` (`generateDashboardHtml`)

**Issue:** `latest.score` was interpolated directly into the HTML `<title>` element. `StoredSession.score` is typed `number`, but it originates from a SQLite column read at runtime — a corrupted or legacy row that survived the new contracts-layer guards in some other path could carry a non-numeric value, breaking the rendered title.

**Fix:** Added a `coerceScoreForTitle(score: unknown): number` helper. Non-finite values fall back to `0`, keeping the page title well-formed and removing the type-system → runtime trust gap at the interpolation site.

## Verification

- `pnpm typecheck` clean
- `pnpm --filter=@opensip-tools/dashboard test` — 118 tests passing, 9 skipped (no regressions)
- `pnpm lint` clean (no nested-ternary warnings after refactoring into a helper)
