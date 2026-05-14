# Multi-Language Support: Overnight Implementation Summary

**Status:** All phases complete. opensip-tools workspace builds and tests cleanly. Nothing has been published; nothing in DART-Lite has been changed.

---

## What you'll see in the repo

`git log --oneline` from the start of overnight work:

```
08692aa feat: warn on unknown languages in target config (Phase 9 validation)
9244aba test: end-to-end multi-language CLI integration test
83517bb feat: lang-cpp + checks-cpp — clang-tidy CommandConfig pattern
e07936c feat: lang-python, lang-java, lang-go adapters + proof checks
d79ebd2 feat: adapter-driven content filter + @opensip-tools/checks-universal
d9db9fa feat(core): plugin loader supports named-export and default-export ...
e6ae0d2 feat(lang-rust): Rust language adapter with strip-strings/comments
7c09b88 feat(lang-typescript): extract TS adapter; migrate 49 checks
d03a914 feat(core): language-aware parse cache + 'lang' plugin domain
61748b4 feat(core): scaffold LanguageAdapter, LanguageRegistry, and types
d4ed1bb docs: rewrite multi-language plan for hard cutover ...
```

**11 commits.** One commit per logical step, no fixups.

---

## What shipped

### New packages (8)

| Package | Purpose | Tests |
|---|---|---|
| `@opensip-tools/lang-typescript` | TS adapter; owns parse-cache + AST utilities | 8 |
| `@opensip-tools/lang-rust` | Rust adapter (hand-written lexer) | 13 |
| `@opensip-tools/lang-python` | Python adapter (all string flavors, prefixes) | 15 |
| `@opensip-tools/lang-java` | Java adapter (text blocks, char literals) | 12 |
| `@opensip-tools/lang-go` | Go adapter (raw strings via backticks) | 10 |
| `@opensip-tools/lang-cpp` | C/C++ adapter (parse returns null; CommandConfig path) | 12 |
| `@opensip-tools/checks-universal` | Cross-language checks (TODO, file length) | 8 |
| `@opensip-tools/checks-{python,java,go,cpp}` | One proof check per language | 7+6+6+6 |

### Core changes

- New `core/src/languages/` module: `LanguageAdapter`, `LanguageRegistry`, `applyContentFilter`, language-aware parse cache.
- New `'lang'` plugin domain — language packs load through the same discovery+loader pipeline as fitness plugins.
- Loader now accepts Check instances and LanguageAdapters as named exports OR default exports (was: `checks=[...]` array only). Single-file plugins under `~/.opensip-tools/fit/` no longer need an array wrapper.
- `CheckScopeSchema` accepts empty `languages` arrays (means "any language") — required for cross-language universal checks.
- `framework/parse-cache.ts` and `framework/ast-utilities.ts` collapsed: TS-specific code moved to `@opensip-tools/lang-typescript`. The 49 checks that imported `getSharedSourceFile` from core were migrated.

### CLI changes

- `fit` command bootstraps all 6 bundled language adapters at startup (typescript, rust, python, java, go, cpp).
- Then loads additional language packs from the `lang` plugin domain.
- Validates target config: unknown `languages` produce a stderr warning naming the offending language and the known set. Run continues (not a fatal error — see decision D7).

### Tests

| Layer | Count | Location |
|---|---|---|
| Core | 243 | packages/core/src/**/__tests__/ |
| Lang adapters | 70 | packages/lang-*/src/__tests__/ |
| Universal checks | 8 | packages/checks-universal/src/__tests__/ |
| Per-language checks | 25 | packages/checks-{python,java,go,cpp}/src/__tests__/ |
| CLI | 150 (incl. 5 new multi-lang) | packages/cli/src/__tests__/ |

**`pnpm test` runs all 30 task targets. All green.**

---

## Architectural decisions to discuss

The full decision log is at `docs/plans/multi-language-support/decisions.md`. Highlights worth your attention:

**D2 — `getSharedSourceFile` shim retained in core's `framework/parse-cache.ts`**
Why: `framework/import-graph.ts` is an internal core utility that uses TS-AST. Moving it to lang-typescript would reverse the dep direction (lang → core, core → lang for utilities). Kept the shim minimal: it resolves the TS adapter from the registry and falls back to direct parse. Trade-off: core still has a runtime dep on `typescript` for `import-graph.ts` and `framework/content-filter.ts`. We can revisit in a future cleanup.

**D4 — Empty `scope.languages` means "any language" (universal scope)**
Loosened `CheckScopeSchema` to accept empty arrays. The runtime matcher already treated empty arrays as match-any; the schema was the only thing rejecting universal checks. Trade-off: a user who forgets to set `scope.languages` gets a universal check by accident. Same risk as forgetting `concerns` (already non-required).

**D5 — `applyContentFilter` falls back to raw content when no adapter is registered**
For files in unrecognized languages (JSON, YAML, plain text), checks requesting `strip-strings` get raw content instead of an error. Preserves backward compat. Trade-off: a check on an unknown-language file may false-fire on text inside string literals. Mitigated by D7 warning at config load time.

**D7 — Warn (don't fail) on unknown languages in target config**
A typo like `pyhton` becomes a warning rather than a build error. Less strict, but matches the "incremental adoption" pattern of multi-language projects. A future `--strict-languages` flag could elevate this to an error.

**D8 — Pure `analyzeXxx` functions extracted for testability**
Every proof check exports a pure analysis function alongside the `defineCheck`-wrapped Check. Tests target the pure function. Established because `defineCheck` wraps `analyze` in an `execute(ctx)` closure that requires an `ExecutionContext`. Pattern is consistent across all checks-* packages.

**D9 — `lang-cpp.parse()` returns null; clang-tidy is the AST analyzer**
Establishes the "command-mode language" pattern. C/C++ checks use `CommandConfig` (clang-tidy) for analysis; the adapter still provides stripStrings/stripComments for regex-based universal checks. Future shellcheck / phpcs adapters follow the same template.

---

## What's NOT done (per your scope)

1. **Not published to npm.** All packages remain workspace-only. `package.json` versions are still 0.6.1; no version bumps were made.
2. **DART-Lite not migrated.** Still uses `link:` paths to local opensip-tools workspace. We'll flip to npm versions together after publishing.
3. **No git push.** All commits are local on the opensip-tools `main` branch.

---

## Sanity-check commands for review

```bash
cd /Users/breens/Documents/Code/opensip-tools

# Inspect the commit history
git log --oneline | head -15

# Verify build and tests are clean
pnpm install && pnpm build && pnpm test

# Run the CLI against the multi-language fixture (proves end-to-end)
cd packages/cli/src/__tests__/fixtures/multi-lang
node ../../../../dist/index.js fit --json | head -30

# Run the CLI against the unknown-language fixture (proves D7)
cd ../unknown-language
node ../../../../dist/index.js fit --json
# stderr should include: "opensip-tools: target config declares unknown language(s): klingon"

# Read the decision log
$EDITOR /Users/breens/Documents/Code/opensip-tools/docs/plans/multi-language-support/decisions.md
```

---

## Numbers

- **11 commits**
- **8 new packages** (5 lang-* + 3 checks-* + checks-universal — wait, that's 9; checks-cpp is the 9th)
- **~3,400 lines added** across all phase commits
- **~70 new tests** (across all new lang/checks packages)
- **0 regressions** — all 145 pre-existing CLI tests still pass

---

## Ready for ship discussion

When you wake up:
1. Review the commit log and decisions.md
2. Decide if any of D2/D4/D5/D7 need rework before publish
3. Bump versions (suggest minor 0.7.0 since this adds new packages and a couple of accepted-but-non-breaking schema relaxations)
4. `npm publish` for each new package + bumped versions of core/cli/checks-builtin/lang-typescript/checks-universal
5. Switch DART-Lite from `link:` deps to npm versions
6. Re-run `npx opensip-tools fit` in DART to confirm the published packages work identically to local linked ones
