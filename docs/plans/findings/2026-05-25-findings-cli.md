# 2026-05-25 — Findings: `@opensip-tools/cli`

Bug & correctness audit of the CLI dispatcher + bootstrap + commands. Auditor: `feature-dev:code-reviewer` agent. Fixes applied in the same pass.

## Findings

### 1. API key written world-readable before `chmod` (HIGH, fixed)

**File:** `src/bootstrap/global-config.ts` (`writeGlobalConfig`)

**Issue:** `writeFileSync(GLOBAL_CONFIG_PATH, …, 'utf8')` created the file with the process's inherited umask (commonly `0o644`, world-readable). The follow-up `chmodSync(…, 0o600)` ran only after the write completed, leaving a TOCTOU window during which another local user could read the file (and the OpenSIP Cloud API key inside). On a shared host this is a credential leak.

**Fix:** Rewrote `writeGlobalConfig` to (a) `openSync` a same-directory temp file with `flags: 'wx'` and `mode: 0o600` so the inode is created with restrictive permissions atomically, (b) `writeSync` the YAML content, (c) `closeSync`, and (d) `renameSync` over the destination. Failures during rename clean up the temp file. This is also atomic against torn reads.

### 2. Hard-coded `/` separator in stale-file classifier breaks Windows (MEDIUM, fixed)

**File:** `src/commands/init.ts` (`classifyOneFile`)

**Issue:** `const basename = absPath.slice(absPath.lastIndexOf('/') + 1)` extracted the filename with a hard-coded Unix separator. On Windows, `node:path` produces backslash-separated paths, `lastIndexOf('/')` returns `-1`, and `slice(0)` returned the entire absolute path. `STALE_FILENAME_PATTERN` never matched, so every stale-scaffolded file on Windows was silently misclassified as `'custom'` and preserved by `--keep` instead of being replaced.

**Fix:** Switched to `pathBasename(absPath)` from `node:path`. The import alias avoids shadowing the local `basename` identifier.

### 3. Non-existent `--cwd` silently exits 0 (MEDIUM, fixed)

**File:** `src/commands/init.ts` (`executeInit`)

**Issue:** When the target directory passed via `--cwd` did not exist, `executeInit` returned `{ created: false, state: 'pristine' }` with no error discriminant set. The `register-init` layer only emits exit code 2 when it sees `ambiguousLanguageError` or `partialStateError`, so `opensip-tools init --cwd /nonexistent` exited 0 with no indication of failure.

**Fix:** A missing target directory now surfaces as `ambiguousLanguageError` with `detected: []` and a clear message. The existing exit-2 path in `register-init` handles it.

### 4. Local-path plugin spec written into config as the plugin name (MEDIUM, fixed)

**File:** `src/commands/plugin.ts` (`pluginAdd`)

**Issue:** When the user installed a plugin via a local-path spec (`file:../my-plugin`, `./pkg`, `/abs/path`), `findInstalledName` could return `undefined`, and the previous code fell back to writing the raw spec into `opensip-tools.config.yml#plugins.<domain>`. Discovery would then fail to load the entry (it expects a real npm name) and a subsequent `plugin remove <spec>` would feed the path-like string to npm as if it were a name.

**Fix:** When the spec is detected as a local-path form and `findInstalledName` cannot resolve a real name, `pluginAdd` now fails explicitly with a descriptive error rather than persisting a broken config entry. Regular registry specs continue to fall back to the spec name as before.

### 5. `npm install` output contaminates `--json` mode (MEDIUM, fixed)

**File:** `src/commands/plugin.ts` (four `execFileSync('npm', …)` sites)

**Issue:** All four npm invocations used `stdio: 'inherit'`. npm writes progress and warnings to stdout — when a caller pipes `opensip-tools plugin add … --json | jq .`, `npm warn …` lines land on the same stdout as the structured CLI result, breaking the JSON parse.

**Fix:** Changed all four sites to `stdio: ['ignore', process.stderr, process.stderr]`. npm's progress output is still visible on the user's terminal (via stderr), but stdout is reserved for the CLI's own output.

## Verification

- `pnpm typecheck` clean
- `pnpm --filter=@opensip-tools/cli test` — 175 tests passing
- `pnpm test` (workspace) — 48/48 tasks passing
- `pnpm lint` clean
