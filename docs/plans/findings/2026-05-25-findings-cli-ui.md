# 2026-05-25 — Findings: `@opensip-tools/cli-ui`

Bug & correctness audit of the Ink/React primitives. Auditor: `feature-dev:code-reviewer` agent. Fixes applied in the same pass.

## Findings

### 1. `ThemeProvider` re-detects capabilities on every render (MEDIUM, fixed)

**File:** `src/theme.ts` (`ThemeProvider`)

**Issue:** `ThemeProvider` called `detectTerminalCapabilities()` directly in the function body. Ink's `ClockProvider` re-renders the tree every tick (used by `Spinner` etc.), and each render allocated a fresh `resolved` object and a new context value reference. This defeated React's bailout and forced every `useTheme()` subscriber (`Banner`, `RunHeader`, `ErrorMessage`, `SpinnerCtx`, `SpinnerStandalone`) to re-render on every animation frame.

**Fix:** Wrapped resolution in `React.useMemo(..., [theme])`. The context value reference is now stable across re-renders; subscribers only re-render when the supplied `theme` prop itself changes.

### 2. `NO_COLOR_THEME` still carried hex `brand` color (MEDIUM, fixed)

**File:** `src/theme.ts` (`NO_COLOR_THEME`)

**Issue:** `NO_COLOR_THEME` was constructed via `...DEFAULT_THEME` with only `colorsEnabled: false` overridden. Ink does not read `colorsEnabled` — it resolves the `color` prop through Chalk unconditionally. So `<Text color={theme.brand}>` still emitted ANSI truecolor for `#C8956C` even when `NO_COLOR=1` was set, violating the [`NO_COLOR` convention](https://no-color.org).

**Fix:** Rewrote `NO_COLOR_THEME` to set every color token to the empty string. Ink's `<Text color="">` no-ops, so all consumers behave correctly without scattering `theme.colorsEnabled` guards across every component.

### 3. Capability flags leak truecolor signal to non-TTY (LOW/MEDIUM, fixed)

**File:** `src/theme.ts` (`detectTerminalCapabilities`)

**Issue:** `supports256Color` and `supportsTrueColor` were derived from `COLORTERM` / `TERM` / `TERM_PROGRAM` *without* the `isTTY` gate. `supportsColor` itself was gated correctly, but callers inspecting `supports256Color` / `supportsTrueColor` to choose hex color values for a piped-to-file stdout would still emit truecolor escapes into the file. The exported `TerminalCapabilities` surface was self-contradictory.

**Fix:** All three flags now AND with `isTTY`. When stdout is piped, every capability flag is false.

## Verification

- `pnpm typecheck` clean
- `pnpm --filter=@opensip-tools/cli-ui ...` — no test suite in this package; verified by inspection and downstream cli/dashboard e2e tests
- `pnpm lint` clean
