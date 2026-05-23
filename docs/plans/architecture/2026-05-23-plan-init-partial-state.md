---
status: proposed
last_verified: 2026-05-23
title: "Plan — `opensip-tools init` partial-state handling"
audience: [contributors, maintainers]
related-audits:
  - ./2026-05-23-architecture-cli.md
related-plans:
  - ./2026-05-22-plan-layer-5-cli.md
---

# Plan — `opensip-tools init` partial-state handling

## Summary

`opensip-tools init` today has three behaviors:

1. **Pristine project** (no config, no `opensip-tools/`) → scaffold everything. Correct.
2. **Fully-initialized project** (config + dir present) → exit early with `alreadyExists: true` and a hint pointing at `--force`. Correct.
3. **Partial / inconsistent state** (config XOR `opensip-tools/`, or dir contents don't match what fresh init would produce) → silently merges new scaffolding into the leftover directory, file-by-file. **This is the gap.**

Path 3 produces footguns:

- A user who manually deleted `opensip-tools.config.yml` to "reset" their setup gets a half-reset: new YAML is written, but the old `opensip-tools/` tree (custom checks, stale-language examples, recipes) survives untouched.
- A polyglot init (`--language typescript,rust`) that's later re-run as single-language leaves orphaned `example-check-rust.mjs` alongside the new `example-check.mjs`. Both register pinned UUIDs; at the next `fit` run the registry sees duplicate scaffolded checks. The pinned UUIDs in `init.ts:218–225` are stable *by design* for session-storage continuity, which compounds the collision.
- The `InitResult` reports `created: true` for the YAML and lists `createdFiles[]`, but says nothing about *skipped-because-already-existed* example files. The user has no signal that legacy content survived.

The audit framework didn't catch this — it focused on SOLID/GoF, not CLI command behavior under unusual states. This plan resolves it.

## Goal

`init` becomes idempotent and informative under partial state. Specifically:

- **Refuses to merge silently.** When the working directory is in an inconsistent state (config XOR dir, or dir contents don't match a fresh-init scaffold for current detection), init exits 2 and prints what's there.
- **Two explicit flags express user intent**, anchored on outcome for user content:
  - `--keep` — re-scaffold examples, preserve custom files. *"I want a fresh starter alongside my work."*
  - `--remove` — delete `opensip-tools/` entirely, then scaffold from zero. *"Clean slate."*
- **`--force` is removed.** It currently does what `--remove` would do (overwrites everything), but the name doesn't carry the user-content distinction. It's only been on `init` for one minor version, so breakage cost is low.
- **Result reports survivors.** `InitResult` gains a `preExistingFiles[]` field so the rendered output and `--json` consumers can see what survived.

## Non-goals

- **Not changing detection.** Language detection (`detectLanguages`) and the `--language` flag stay as-is. This plan only touches the partial-state decision tree.
- **Not changing pinned UUIDs.** The stability claim in `init.ts:212–225` is correct for session-storage; we don't generate per-init UUIDs.
- **Not adding interactive prompts.** Init stays non-interactive — partial-state surfaces with an exit-2 error and a flag hint, not a `[y/N]` prompt. Keeping non-interactive matches the rest of the CLI's surface (only `uninstall` and `configure` prompt today, and those are the right places to prompt).
- **Not touching `uninstall`.** `uninstall --project` correctly removes both the dir and the config; that's not a partial-state producer.

## Decision tree

After parsing flags, init classifies the working directory into one of four states:

| State | `opensip-tools.config.yml` | `opensip-tools/` directory | Default behavior | `--keep` behavior | `--remove` behavior |
|---|---|---|---|---|---|
| **A. Pristine** | absent | absent | Scaffold | Scaffold | Scaffold |
| **B. Fully initialized** | present | present | Exit 2, `alreadyExists` | Re-scaffold examples; preserve custom; rewrite YAML | `rm -rf opensip-tools/`; rewrite YAML; scaffold |
| **C. Partial — config only** | present | absent | Exit 2, partial-state error | Scaffold examples (no custom files exist) | Scaffold (same as `--keep` here) |
| **D. Partial — dir only** | absent | present | Exit 2, partial-state error | Re-scaffold examples; preserve custom; write YAML | `rm -rf opensip-tools/`; write YAML; scaffold |

State **B** is "fully initialized" — both pieces present. Default refuses (today's behavior modulo flag rename).

States **C** and **D** are the *partial* states. Default refuses with a clear message; flags express explicit intent.

## File classification (for State B and D)

Inside `opensip-tools/`, init classifies each file:

- **Scaffolded** — matches a current-init template byte-for-byte, OR carries a pinned UUID from `EXAMPLE_CHECK_IDS` / known recipe IDs.
- **Custom** — anything else (user-authored).
- **Stale-scaffolded** — was scaffolded by a previous init for a *different* language combo than current detection (e.g. `example-check-rust.mjs` exists, but current detection is `typescript` only).

`--keep` preserves Custom; overwrites Scaffolded; warns about Stale-scaffolded but leaves them in place (the user may have been working with them).

`--remove` deletes the whole directory unconditionally — no classification needed.

## Implementation

### Phase 1 — Contract changes

**`packages/contracts/src/types.ts`:**

- Replace `InitOptions.force: boolean` with:
  ```ts
  /**
   * Re-scaffold example files. Preserve any custom files in opensip-tools/.
   * Mutually exclusive with `remove`.
   */
  keep?: boolean;
  /**
   * Delete opensip-tools/ entirely, then scaffold fresh.
   * Mutually exclusive with `keep`.
   */
  remove?: boolean;
  ```

- Extend `InitResult`:
  ```ts
  /**
   * The state of the working directory at init time. Useful for
   * `--json` consumers and for the rendered output to show what
   * happened.
   */
  state?: 'pristine' | 'fully-initialized' | 'partial-config-only' | 'partial-dir-only';

  /**
   * Files that existed before init ran, classified. Empty in state
   * 'pristine'. Populated for the other states so the user can see
   * what survived (`--keep`) or was removed (`--remove`).
   */
  preExistingFiles?: readonly {
    readonly path: string;
    readonly classification: 'scaffolded' | 'custom' | 'stale-scaffolded';
  }[];

  /**
   * When init refuses due to partial state and no flag was passed,
   * surfaces what's there + a flag hint. Set together with
   * `created: false`.
   */
  partialStateError?: {
    readonly state: 'partial-config-only' | 'partial-dir-only' | 'fully-initialized';
    readonly preExistingFiles: readonly { readonly path: string; readonly classification: 'scaffolded' | 'custom' | 'stale-scaffolded' }[];
    readonly message: string;
  };
  ```

- Drop `InitResult.alreadyExists`. Replace with `state === 'fully-initialized'` test in `InitFeedback`. The contract change is a breaking-but-narrow rename; `alreadyExists` only has one consumer (`InitFeedback`) and the CLI is the only direct consumer of the `init` shape.

### Phase 2 — `executeInit` rewrite

**`packages/cli/src/commands/init.ts`:**

Replace `executeInit`'s top-level flow:

```ts
export function executeInit(args: CliArgs & { language?: string; keep?: boolean; remove?: boolean }): InitResult {
  const cwd = args.cwd;
  const keep = args.keep === true;
  const remove = args.remove === true;
  const paths = resolveProjectPaths(cwd);
  const baseResult = { type: 'init' as const, path: paths.configFile, cwd, configFilename: 'opensip-tools.config.yml' };

  // Reject mutually-exclusive flags.
  if (keep && remove) {
    return {
      ...baseResult,
      created: false,
      state: 'pristine', // will be overwritten if we surface this differently
      partialStateError: {
        state: 'fully-initialized',
        preExistingFiles: [],
        message: '--keep and --remove are mutually exclusive.',
      },
    };
  }

  if (!existsSync(cwd)) {
    return { ...baseResult, created: false, state: 'pristine' };
  }

  const resolution = resolveLanguages(cwd, args.language);
  if (!resolution.ok) {
    return { ...baseResult, created: false, state: 'pristine', ambiguousLanguageError: resolution.error };
  }
  const { languages } = resolution;

  // Classify the working directory.
  const state = classifyWorkingDir(paths);
  const preExistingFiles = state === 'pristine' ? [] : classifyFiles(paths, languages);

  // Pristine: scaffold and exit. No flag interaction needed.
  if (state === 'pristine') {
    return scaffold(paths, languages, baseResult, /* removeFirst */ false);
  }

  // Fully initialized or partial: require explicit flag.
  if (!keep && !remove) {
    return {
      ...baseResult,
      created: false,
      state,
      preExistingFiles,
      partialStateError: {
        state,
        preExistingFiles,
        message: buildPartialStateMessage(state, preExistingFiles),
      },
    };
  }

  // --remove: blow away the dir, then scaffold.
  if (remove) {
    rmSync(paths.userSourceDir, { recursive: true, force: true });
    return scaffold(paths, languages, baseResult, /* removeFirst */ true, preExistingFiles);
  }

  // --keep: re-scaffold examples, preserve custom files.
  return scaffold(paths, languages, baseResult, /* removeFirst */ false, preExistingFiles, /* keepCustom */ true);
}
```

Key helpers:

- `classifyWorkingDir(paths): 'pristine' | 'fully-initialized' | 'partial-config-only' | 'partial-dir-only'` — single-purpose classifier.
- `classifyFiles(paths, currentLanguages): { path, classification }[]` — walks `opensip-tools/`, tags each file. The "is this scaffolded?" check is content-based: hash the file vs. the current-template content for the same relative path. The "stale-scaffolded" check looks for files that match the *template path shape* (`example-check-<lang>.mjs`) but a language not in the current set, OR carry a pinned `EXAMPLE_CHECK_IDS` UUID for a language not in the current set.
- `scaffold(...)` — the existing scaffolding code, parameterized by whether to overwrite scaffolded files. The current `force` param becomes a more nuanced "overwrite scaffolded; leave custom" rule.

### Phase 3 — Commander wiring

**`packages/cli/src/commands/register-init.ts`:**

```ts
const cmd = program
  .command('init')
  .description('Scaffold opensip-tools.config.yml + example checks/scenarios for your project')
  .option(CWD_OPTION_SPEC, 'Target directory', process.cwd())
  .option('--language <list>', 'Comma-separated language list (typescript|rust|python|go|java|cpp). Default: detect from filesystem markers.')
  .option('--keep', 'Re-scaffold example files. Preserve any custom files in opensip-tools/.', false)
  .option('--remove', 'Delete opensip-tools/ entirely, then scaffold fresh.', false)
  .option('--json', JSON_DESC, false)
  .option('--debug', 'Enable debug mode for structured log output', false);
```

Drop `--force`. The deprecation doesn't get an alias — it's the wrong shape and we'd rather break loudly than carry a confusing alternative.

### Phase 4 — Render layer

**`packages/cli/src/ui/components/InitFeedback.tsx`:**

Three new branches, replacing the `alreadyExists` branch:

- `partialStateError` present → render the error message + a list of pre-existing files + the flag hint:
  ```
  ⚠ opensip-tools/ already exists at /path/to/proj
    Found 3 files:
      fit/checks/my-real-check.mjs       (custom)
      fit/checks/example-check-rust.mjs  (stale — was scaffolded for rust; current detection: typescript)
      fit/recipes/example-recipe.mjs     (scaffolded)

    Choose one:
      opensip-tools init --keep    Re-scaffold examples; preserve custom files.
      opensip-tools init --remove  Delete opensip-tools/ and scaffold fresh.
  ```
- `state === 'fully-initialized'` with successful scaffold → "Re-scaffolded" header instead of "Scaffolded", list of overwritten + preserved files.
- `state` partial with successful scaffold → "Recovered partial state" header, list of what was kept / removed.

### Phase 5 — Tests

**`packages/cli/src/__tests__/init.test.ts`:**

- Add tests for state C (config-only): default refuses; `--keep` writes the dir; `--remove` writes the dir.
- Add tests for state D (dir-only): default refuses; `--keep` preserves custom files + writes YAML; `--remove` blows away dir + writes YAML.
- Add tests for state B (fully initialized): default refuses (existing behavior, just rename `alreadyExists` → `state === 'fully-initialized'`); `--keep` overwrites scaffolded but preserves custom; `--remove` blows away dir.
- Add a polyglot drift test: scaffold with `--language typescript,rust`, then re-run with `--language typescript` and `--keep`, confirm the rust example is classified `stale-scaffolded` and surfaces in the output but is preserved.
- Add a `--keep --remove` mutex test (rejects).

Existing `executeInit (alreadyExists)` test (`init.test.ts:229–240`) ports to `executeInit (fully-initialized state)` with the new field name.

### Phase 6 — Docs

- `CLAUDE.md` — update the new-customer flow ("`init` → `fit --recipe example`") to mention what happens on re-init.
- `docs/architecture/70-surfaces/02-plugin-authoring.md` (or wherever init is documented) — describe the four states and the two flags.
- README — update if the `init` flag list appears there.

## Acceptance

- `opensip-tools init` on a partial-state project exits 2, prints the file list, and points at `--keep` / `--remove`. No silent merge.
- `opensip-tools init --keep` on a partial-state project re-scaffolds examples, preserves custom files, and reports both lists in `InitResult.preExistingFiles[]`.
- `opensip-tools init --remove` on a partial-state project deletes `opensip-tools/`, then scaffolds. `InitResult.preExistingFiles[]` lists what got removed.
- `opensip-tools init --keep --remove` exits 2 with "mutually exclusive."
- `opensip-tools init --force` exits 2 with "unknown flag" (commander default).
- The polyglot drift case (`example-check-rust.mjs` after re-detecting only typescript) classifies the rust file as `stale-scaffolded` and surfaces it.
- `pnpm typecheck && pnpm test && pnpm lint` clean.

## Risk / breakage

- **`--force` removal is a breaking flag change.** It's been on `init` for one minor version. The breakage surface is users who scripted `opensip-tools init --force` in CI; they get an unknown-flag error and a clear next step. Document in the next CHANGELOG entry as a Breaking change with the migration: `--force` → `--remove` (closest semantic match — current `--force` overwrites everything, including custom).
- **`InitResult.alreadyExists` removal.** Only one consumer (`InitFeedback`). Internal-only contract; not a published shape that downstream tools consume. Safe.
- **File classification cost.** `classifyFiles` walks `opensip-tools/` and reads each file to hash against current templates. Bounded by the project's `opensip-tools/` tree size, which is small (kilobytes). Fine.

## Sequencing

This plan is independent of the audit-remediation work. It can ship as a single PR after Wave 5 (the audit closeouts) lands. Estimated ~2 days of work given the small surface and clear contract boundaries.
