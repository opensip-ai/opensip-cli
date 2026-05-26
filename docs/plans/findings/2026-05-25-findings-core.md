# 2026-05-25 — Findings: `@opensip-tools/core`

Bug & correctness audit of the core kernel package. Auditor: `feature-dev:code-reviewer` agent. Fixes applied in the same pass on branch `worktree-2026-05-25-findings-core`.

## Findings

### 1. Plugin entry-point path traversal (MEDIUM, fixed)

**File:** `src/plugins/discover.ts` (`tryDiscoverPackage`), `src/plugins/package-entry.ts` (`resolvePackageEntryPoint`)

**Issue:** `resolvePackageEntryPoint` joins `packageDir + rawEntry` where `rawEntry` is whatever value `pkg.main` / `pkg.exports` declares — including `../../escape/evil.js`. The package-dir containment check in `discoverNpmPackages` catches symlinked package directories but does not extend to the entry-file path resolved from the package's own `package.json`. A malicious or accidentally-malformed plugin could traverse out of `node_modules` and have its escape file dynamically `import()`-ed by the loader.

**Fix:** `tryDiscoverPackage` now calls `isPathInside(resolved.entry, packageDir)` after `resolvePackageEntryPoint` returns. Entries that resolve outside the package directory are logged at `warn` level (`plugin.loader.discover.reject`, reason `entry point resolves outside package directory`) and skipped.

### 2. Line-continuation false positive on escaped backslash (MEDIUM, fixed)

**File:** `src/languages/strip-utils.ts` (`scanLineComment`)

**Issue:** The C/C++ phase-2 line-splice detection used a single-character lookback (`src[i - 1] === '\\'`). It could not distinguish `\<newline>` (a genuine splice — comment continues) from `\\<newline>` (an escaped backslash followed by an unrelated newline — comment ends). Real C/C++ code with `\\` at end-of-line would silently consume the next physical line, producing a stripped output that diverges from the language spec.

**Fix:** Introduced `hasUnescapedTrailingBackslash` helper that counts consecutive trailing backslashes between the comment body start and the newline. An odd count signals an unescaped trailing `\` (real splice); even count signals balanced escapes (no splice). Bounded the back-walk to `bodyStart` so backslashes from before `//` cannot leak into the count.

### 3. Logger formats entry when nothing will be written (LOW, not fixed — informational)

**File:** `src/lib/logger.ts` (`LoggerImpl.log`)

**Issue:** Early-return guard `if (!this.shouldLog(level) && !this.logFilePath) return` does not account for the case where `logFilePath` is set but `shouldWriteToFile(level)` is false. In that case, `formatEntry` allocates an entry object that is immediately discarded.

**Decision:** Deferred — the allocation overhead is negligible at the per-call rate this code path sees (debug logs run per-file, not per-token). Pre-optimizing would couple `log()` to the file-write decision and tangle two concerns that are currently separate.

## Verification

- `pnpm typecheck` clean
- `pnpm --filter=@opensip-tools/core test` — 295 tests passing (no new tests required; existing coverage on `scanLineComment`, `discoverNpmPackages`, and the `isPathInside` helper exercises the fixed paths)
- `pnpm lint` clean (ESLint + dependency-cruiser)
