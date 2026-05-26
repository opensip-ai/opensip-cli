# Phase 9: Validation

**Goal:** Run the full integrated flow against real CLI invocations across the eleven verification scenarios from the original brief. Validation lives at the subprocess-spawn layer — not unit, not mocked — so it exercises the actual binary output a customer would see.
**Depends on:** All prior phases including Tests.

This phase is a scaffold. The plan-improvements pipeline (Phase 10) would normally specify exact end-to-end flows and observability assertions. Without it, scenarios are listed verbatim from the original brief; the implementing agent translates each into a subprocess-spawn assertion.

---

## Task 9.1: End-to-end discovery + Project: header scenarios

**Files:** [size: M]
- Create: `packages/cli/src/__tests__/e2e-discovery.test.ts`
- Modify: `packages/cli/src/__tests__/e2e.test.ts` (cross-reference; add a top-of-file pointer to the new file)

**Context:** The eleven verification scenarios in the brief map one-to-one to validation cases. Each case is "set up a tmp project state, spawn the CLI binary, assert stdout/stderr/exit code + filesystem state."

A shared helper `runCli({ args, cwd, env? }): { stdout, stderr, exitCode }` should already exist or be modeled on `e2e.test.ts`. If not, build one — it's load-bearing for every case here.

**Steps:** Implement each of the eleven scenarios:

1. **From repo root, `fit` works as today, prints Project: header.**
   Setup: `mkdtemp` + `init`. Run `fit-list` (lighter than `fit`). Assert `stdout` starts with `ℹ Project: <tmpdir>\n`, no `(found ... up)` suffix.

2. **From `packages/api/`, `fit` walks up, finds root, prints `Project: <root> (found 2 levels up)`.**
   Setup: tmpdir with config + nested `packages/api/`. Run `fit-list` with `cwd = .../api`. Assert header line is `ℹ Project: <tmpdir>  (found 2 levels up)`. Assert `.runtime/` was created at `<tmpdir>/opensip-tools/`, NOT at `<tmpdir>/packages/api/opensip-tools/`.

3. **From `/tmp/empty`, `fit` errors with "No opensip-tools project found".**
   Setup: empty `mkdtemp` (no `init`). Run `fit-list`. Assert non-zero exit code, stderr contains `No opensip-tools project found`, contains `To get started:\n    opensip-tools init`.

4. **From `/tmp/empty`, `init` scaffolds at `/tmp/empty` (no parent to discover).**
   Setup: empty `mkdtemp`. Run `init`. Assert exit 0, `opensip-tools.config.yml` exists at the tmpdir, `opensip-tools/fit/checks/` exists.

5. **From `packages/api/`, `init` refuses with three-option message.**
   Setup: tmpdir with `init` already run + nested `packages/api/`. Run `init` from `.../api` with no `--cwd`. Assert exit 2, stderr contains the refusal banner + all three option commands with the right path interpolated.

6. **From `packages/api/`, `init --cwd .` scaffolds a new sub-project (escape hatch).**
   Same setup as 5. Run `init --cwd .`. Assert exit 0, a new `opensip-tools.config.yml` appears at `.../api/` (nested project scaffolded intentionally).

7. **`uninstall --project` (default) removes only `.runtime/`, prints `KEPT` section.**
   Setup: tmpdir + `init` + fake `.runtime/` content + a custom check file. Run `uninstall --project --yes`. Assert `.runtime/` removed, `opensip-tools/fit/checks/*.mjs` preserved, `opensip-tools.config.yml` preserved, stdout contains `These will be KEPT`.

8. **`uninstall --project --purge` removes everything with warning + git hint.**
   Same setup. Run `uninstall --project --purge --yes`. Assert everything under `opensip-tools/` and the config file removed, stdout contains `⚠ This removes EVERYTHING` and `git status`.

9. **Config with `schemaVersion: 99` errors with upgrade-CLI message (corrected direction).**
   Setup: tmpdir with hand-written `opensip-tools.config.yml` containing `schemaVersion: 99`. Run any command (e.g. `fit-list`). Assert exit 2, stderr contains `uses a newer schema than your CLI supports` and `npm install -g @opensip-tools/cli@latest`. Crucially: stderr must NOT contain "migrate" — that's the old, wrong messaging that the review caught.

10. **Config missing `schemaVersion` works as v1 silently.**
    Setup: tmpdir with config that lacks the field. Run `fit-list`. Assert exit 0, no schema-version warning in stderr.

11. **The phantom dir at `/Users/sb/.../opensip/opensip-tools/fit/opensip-tools/` no longer recreated.**
    This is a manual + automated check. Automated: set up `tmpdir/opensip-tools.config.yml` + `tmpdir/opensip-tools/.runtime/old-phantom-marker.txt` (simulating a pre-fix fossil). Run `fit-list` from a fresh nested `tmpdir/sub/`. Assert: `tmpdir/sub/opensip-tools/` does NOT exist (phantom not recreated). Stderr contains the phantom-detect warning IF `tmpdir/sub/opensip-tools/.runtime/` was set up as a phantom; otherwise no warning. Manual smoke: in the real sibling `opensip` repo, run `cd opensip-tools/fit && opensip-tools fit-list` after `rm -rf opensip-tools/fit/opensip-tools/` — confirm no phantom regenerates and no errors.

**Wiring:** Each case uses the shared subprocess helper. Each case is independent — failures don't cascade.

**Verification:**

```bash
pnpm build && pnpm --filter=@opensip-tools/cli test e2e-discovery
```

**Commit:** `test(cli): end-to-end validation for project discovery + lifecycle`

---

## Task 9.1b: Tool-specific scenarios — fit, sim, graph honor discovery

**Files:** [size: M]
- Extend: `packages/cli/src/__tests__/e2e-discovery.test.ts` (same file as Task 9.1)

**Context:** Adding these specifically because the original review caught that an earlier draft would have missed them. Phase 3's tool-package migration (Tasks 3.6–3.8) is the most-impactful behavior change of the plan and deserves explicit end-to-end coverage at the binary level, not just unit-level.

**Steps:** For each of `fit`, `sim`, `graph`, repeat the core scenario:

```
Given:  tmpdir/opensip-tools.config.yml (with proper minimal config for the tool)
        tmpdir/packages/api/   (no opensip-tools/ subtree here)
When:   spawn `opensip-tools <tool>` with cwd = tmpdir/packages/api
Then:   exit 0 (or expected exit for the tool)
        Project: header shows tmpdir with "(found 2 levels up)"
        .runtime/ artifacts after the run live at tmpdir/opensip-tools/.runtime/
        NO .runtime/ created at tmpdir/packages/api/opensip-tools/.runtime/
```

For each tool, additionally:
- Run with explicit `--cwd <tmpdir>` from a third location (`/tmp`). Same assertions.
- Run with `--json`. Header suppressed; outputs valid JSON.

These are the "the bug fix actually reaches the most-used commands" cases. They are the safety net for regression — if a future refactor removes `cli.project` from a tool's action handler, these tests fail loudly.

**Verification:** `pnpm --filter=@opensip-tools/cli test e2e-discovery`

**Commit:** `test(cli): verify fit/sim/graph honor project-root discovery end-to-end`

---

## Task 9.2: Cleanup the existing phantom directory in the sibling repo

**Files:** [size: XS]
- No code change. Documentation + manual operation.

**Context:** The real phantom at `/Users/sb/Documents/Code/opensip-ai/opensip/opensip-tools/fit/opensip-tools/` contains only `.runtime/logs/2026-05-17.jsonl` (verified during research). It's safe to delete and was the original bug evidence.

**Steps:**

1. Verify the phantom still exists and still contains only `.runtime/`:

   ```bash
   find /Users/sb/Documents/Code/opensip-ai/opensip/opensip-tools/fit/opensip-tools -type f
   # Expected: only files under .runtime/
   ```

2. Delete:

   ```bash
   rm -rf /Users/sb/Documents/Code/opensip-ai/opensip/opensip-tools/fit/opensip-tools
   ```

3. Also delete the worktree copy:

   ```bash
   rm -rf /Users/sb/Documents/Code/opensip-ai/opensip/.claude/worktrees/ticket-lifecycle-extraction/opensip-tools/fit/opensip-tools
   ```

4. Document in the PR description that the phantom was cleaned manually and the Phase 7 phantom-detect warning was tested against this fossil before deletion.

**Wiring:** None — this is the on-disk hygiene step, separate from the code change.

**Verification:**

```bash
find /Users/sb/Documents/Code/opensip-ai/opensip -name "opensip-tools" -type d 2>/dev/null | grep -v node_modules | grep "fit/opensip-tools"
# Expected: no output (phantom gone)
```

**Commit:** No commit required — this is a one-off manual cleanup. Note in the PR description.

---

## Phase 9 End-to-End Verification

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint && pnpm fit
```

All eleven verification scenarios pass. `pnpm fit` (fitness checks on this very repo) continues to pass with the new code in place. CHANGELOG.md has an entry documenting the `uninstall --project` breaking default change.

> **Deferred:** A full UX walkthrough video / screencap demonstrating the new behavior in a real terminal. Useful for the release announcement but not a blocker for merge.

---

## Final coherence check across the plan

Before marking the plan complete and the implementation work green:

- Confirm each phase file's "Verification" command actually runs in this repo (no copy-paste references to unrelated commands).
- Confirm cross-references between phases resolve (e.g. Phase 4's reference to `args.cwdExplicit` set by Phase 3.1).
- Confirm no phase invalidated an earlier phase's work (e.g. Phase 5's uninstall refactor uses the path resolution Phase 3.2 introduced).
- Confirm the `dependency-cruiser` config (`/Users/sb/Documents/Code/opensip-ai/opensip-tools/.dependency-cruiser.cjs`) does not need rules added for the new file paths (`core/lib/project-root.ts`, `core/lib/config-version.ts`, `core/lib/phantom-detect.ts`, `cli-ui/src/project-header.ts`). All sit in existing-permitted package directories — no rule change anticipated. Verify with `pnpm lint` during Phase 0.
