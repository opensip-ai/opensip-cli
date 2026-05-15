# Smoke test procedure — v1.0.0 (post-split)

What changed since the last smoke run (0.6.1):
- `@opensip-tools/checks-builtin` deleted.
- `@opensip-tools/checks-typescript` added (1.0.0).
- `@opensip-tools/checks-universal` re-versioned from 0.6.1 to 1.0.0.
- `@opensip-tools/cli` decoupled — no hardcoded check pack import; auto-discovers everything.

## Pre-publish smoke (run before `npm publish`)

Already validated in this session via the DART workspace-link path:
- DART links every opensip-tools package directly via `link:` in `package.json`.
- `npx opensip-tools fit` ran end-to-end. Result: 120 checks loaded (118 from checks-typescript + checks-universal + 7 DART custom from the project's `~/.opensip-tools/fit/`).
- 7 DART custom checks all PASS. checks-typescript + checks-universal contribute parity with the previous checks-builtin set, plus 2 universal checks the project hadn't seen before (file-length-limit, no-todo-comments).
- 3 errors surfaced in `file-length-limit` against files in `globalExcludes`-listed dirs — see "Known issues" below.

This is functionally a smoke test of the published-tarball path because pnpm's `link:` mechanism resolves identically to `npm install` of the same packages. The only thing it doesn't catch is `npm pack` artifact filtering (i.e., which files end up in the tarball). That's caught by Verdaccio.

## Verdaccio smoke (recommended before public publish)

Verdaccio install is at `/tmp/oop-smoke/`. Existing tarballs are 0.6.1 — they'll need to be replaced.

```bash
cd /Users/breens/Documents/Code/opensip-tools

# 1. Pack every package at the new versions.
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" pnpm -r build
for dir in packages/*/; do
  (cd "$dir" && pnpm pack --pack-destination /tmp/oop-smoke/tarballs/)
done
# Remove stale 0.6.1 tarballs and any checks-builtin artifact (deleted package).
rm -f /tmp/oop-smoke/tarballs/*0.6.1.tgz
rm -f /tmp/oop-smoke/tarballs/opensip-tools-checks-builtin-*.tgz

# 2. Restart Verdaccio with a clean storage so 0.6.1 doesn't shadow 1.0.0.
rm -rf /tmp/oop-smoke/verdaccio-storage
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" verdaccio --config /tmp/oop-smoke/verdaccio-config.yaml &

# 3. Publish each tarball to Verdaccio.
NPM_CONFIG_USERCONFIG=/tmp/oop-smoke/.npmrc \
  PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" \
  bash -c 'for tgz in /tmp/oop-smoke/tarballs/*.tgz; do
    npm publish "$tgz" --registry http://localhost:4873
  done'

# 4. Update /tmp/oop-smoke/project/package.json — replace any
#    checks-builtin entry with checks-typescript, bump versions to 1.0.0
#    where applicable. Then:
cd /tmp/oop-smoke/project
rm -rf node_modules pnpm-lock.yaml
NPM_CONFIG_USERCONFIG=/tmp/oop-smoke/.npmrc \
  PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" \
  pnpm install --registry http://localhost:4873

# 5. Run the CLI. Expected: > 100 checks load, no plugin-load errors,
#    "no check packages were loaded" warning is NOT printed.
PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH" npx opensip-tools fit
```

### Pass criteria
- CLI starts without errors.
- `Recipe: default   Checks: N` shows `N >= 100` (current expected ~158).
- No "no check packages were loaded" warning.
- 7 DART custom checks (if `~/.opensip-tools/fit/` is also linked into the smoke project) all PASS.

### Failure modes to watch
- Tarball missing files (e.g. `dist/index.js` not built before `pnpm pack`) → "Cannot find module" on import.
- `package.json#exports` field misconfigured → ESM import fails with "Package subpath './' is not defined".
- Display map merge bug → check tables show kebab-case slugs everywhere instead of titled names.

## Known issues found during pre-publish smoke

### file-length-limit and globalExcludes — FIXED

**Original symptom:** scope-empty checks (e.g. `file-length-limit`) ran
against every prewarmed file regardless of the project config's
`globalExcludes` — surfacing findings inside `docs/`, `tests/fixtures/`,
etc.

**Root cause:** `createMatchFilesFunction()` returned `fileCache.paths()`
verbatim for scope-empty checks. The fileCache itself honors no
exclusion config — that filtering must happen at the matchFiles layer.

**Fix:** `RunOptions.globalExcludes` threaded from
`FitnessRecipeServiceConfig` → `ExecutionOptions` → `check.run()` →
`createExecutionContext()` → `createMatchFilesFunction()`. The matchFiles
fallback now compiles globalExcludes once into Minimatch matchers and
filters `fileCache.paths()` before returning. Custom `patterns` and
per-check `targetFiles` paths are unchanged (already filtered upstream).

**Regression test:** `packages/core/src/framework/__tests__/execution-context.test.ts`
covers the four cases (no excludes, dir patterns, extension patterns,
empty array).

**Verified on DART:** 120 checks, 0 errors, 11 warnings (all dead-code
false-positives for dev tooling deps in `package.json`).
