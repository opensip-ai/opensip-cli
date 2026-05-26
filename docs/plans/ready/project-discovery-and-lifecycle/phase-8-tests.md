# Phase 8: Tests

**Goal:** Cover the work in Phases 0–7 with unit + integration tests. Critical regression assertions: nested-scaffold bug cannot recur; uninstall safe-default preserves user content; init refusal fires for the right cases; schemaVersion skew is detected.
**Depends on:** All implementation phases.

This phase is a scaffold. The plan-improvements pipeline (Phase 10 in that pipeline) would normally enrich the specific test cases, vitest patterns, mock conventions, and helper choices. Because the pipeline did not run, the implementing agent should consult `packages/cli/src/__tests__/e2e.test.ts` (existing CLI E2E test) and `packages/core/src/lib/__tests__/` as pattern references.

---

## Task 8.1: Unit tests for `resolveProjectContext`

**Files:** [size: M]
- Verify: `packages/core/src/lib/__tests__/project-context.test.ts` (created in Phase 0.2)

**Context:** Phase 0.2 created the unit tests. This task is a re-audit: confirm the cases listed there are all present + passing, add any cases identified during Phase 0–7 implementation that weren't anticipated (e.g. symlink-traversal cases, additional `package.json` pointer edge cases discovered when wiring tool packages).

**Steps:** Re-audit + supplement as needed. Specifically verify the `package.json#opensip-tools.configPath`-at-ancestor case from Phase 0.2's test list is present.

**Verification:** `pnpm --filter=@opensip-tools/core test project-context`

---

## Task 8.2: Unit tests for `config-version`

**Files:** [size: S]
- Create: `packages/core/src/lib/__tests__/config-version.test.ts`

**Context:** Permissive reader must return 1 in every "couldn't determine the field" case. The compat check is a pure function — fully unit-testable with no fs.

**Steps:** Test cases:
- Missing file → 1
- Malformed YAML → 1
- YAML array at root (not object) → 1
- Object with no `schemaVersion` key → 1
- `schemaVersion: "1"` (string) → 1 (permissive)
- `schemaVersion: 1.5` (non-integer) → 1
- `schemaVersion: 0` (out-of-range) → 1
- `schemaVersion: 1` → 1
- `schemaVersion: 2` → 2
- `checkSchemaCompat(1)` → `{kind: 'ok', configVersion: 1}`
- `checkSchemaCompat(99)` → `{kind: 'cli-too-old', configVersion: 99, cliVersion: 1}` (CLI needs upgrading)
- `checkSchemaCompat(0)` → `{kind: 'older', configVersion: 0, cliVersion: 1}` (defensive; shouldn't happen because reader clamps to 1, but the function should still be well-behaved)

**Verification:** `pnpm --filter=@opensip-tools/core test config-version`

---

## Task 8.3: Unit tests for `detectPhantomRuntimes`

**Files:** [size: M]
- Create: `packages/core/src/lib/__tests__/phantom-detect.test.ts`

**Context:** Tests are fixture-based with `mkdtemp`. The detector's "conservative" filter is the critical assertion — false positives could lead a user to delete user content.

**Steps:** Test cases:
- `cwd === root` (no ancestors to scan) → empty result
- `cwd` not below `root` (unrelated paths) → empty result
- One `opensip-tools/.runtime/` between cwd and root with no other content → returns that path
- One `opensip-tools/` with `.runtime/` AND `fit/checks/foo.mjs` → returns NOTHING (legitimate content)
- One `opensip-tools/` with `.runtime/` AND `.gitignore` → returns the path (dotfiles ignored except `.runtime` itself)
- Multiple phantoms in a chain → returns all of them
- Symlink that loops back into the scan path → does not infinite-loop (the walker stops at filesystem root)
- Logs the `cli.phantom.runtime.detected` info event with the right shape when phantoms found

**Verification:** `pnpm --filter=@opensip-tools/core test phantom-detect`

---

## Task 8.4: Integration test — discovery in bootstrap (fit, sim, graph)

**Files:** [size: L]
- Create: `packages/cli/src/__tests__/bootstrap-discovery.test.ts`

**Context:** Spawn the CLI binary from a tmp project + subdir setup. Assert it operates on the project root (not the subdir) by checking the location of side-effect files (`.runtime/logs/`, `.runtime/datastore.sqlite`). **Crucially, exercise all three first-party tools** — `fit`, `sim`, `graph` — because they each have their own action handler and the original review caught that an earlier draft of this plan would have missed them. The integration test is the safety net that catches a regression where a tool stops reading `ctx.project.projectRoot`.

**Steps:** Setup helper:

```ts
async function setupProject(): Promise<{ root: string; subdir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'opensip-discovery-'));
  await writeFile(join(root, 'opensip-tools.config.yml'), 'schemaVersion: 1\n');
  const subdir = join(root, 'packages', 'api');
  await mkdir(subdir, { recursive: true });
  return { root, subdir };
}
```

Cases (all repeated for `fit-list`, `sim` (dry-run mode), and `graph`):
- Run from `subdir`. Assert `.runtime/logs/*.jsonl` exists at `<root>/opensip-tools/`, NOT at `<subdir>/opensip-tools/`.
- Run from `subdir`. Assert stdout starts with `ℹ Project: <root>  (found 2 levels up)`.
- Run from `<root>` itself. Assert stdout starts with `ℹ Project: <root>` (no walked-up suffix).
- Run with `--json`. Assert stdout does NOT contain the `Project:` header (JSON output is clean).
- Run with explicit `--cwd /path/to/root` from `/tmp`. Assert datastore + logs land at `/path/to/root/opensip-tools/.runtime/`, NOT at `/tmp/opensip-tools/.runtime/`. (This is the explicit-`--cwd` correctness case the reviewer flagged — covers Phase 1.4's lazy-datastore fix.)
- Run from `/tmp` (no config anywhere up). Assert "No opensip-tools project found" error + exit 2. The Project: header is suppressed (scope === 'none').
- Run `completion zsh` from `subdir`. Assert stdout is shell code with NO leading "ℹ Project:" line. Then `zsh -n <stdout>` exits 0 (the completion script is syntactically valid).

**Verification:** `pnpm --filter=@opensip-tools/cli test bootstrap-discovery`

---

## Task 8.5: Integration test — init refusal inside existing project

**Files:** [size: M]
- Create or extend: `packages/cli/src/__tests__/init-refusal.test.ts`

**Context:** Direct call to `executeInit` (not subprocess spawn) is faster + sufficient. Wire `args.projectRoot` + `args.cwdExplicit` manually.

**Steps:** Cases:
- `executeInit({ cwd: subdir, projectRoot: root, cwdExplicit: false })` → returns `{ created: false, insideExistingProject: { discoveredRoot: root, message: <three-option string> } }`. Assert message contains all three bullet points and the `root` path is interpolated correctly.
- `executeInit({ cwd: subdir, projectRoot: root, cwdExplicit: true })` → proceeds (escape hatch).
- `executeInit({ cwd: tmpfresh, projectRoot: undefined, cwdExplicit: false })` → proceeds (no parent project found).
- `executeInit({ cwd: root, projectRoot: root, cwdExplicit: false })` → proceeds (cwd is the root, not below it — refusal predicate `projectRoot !== cwd` is false).

**Verification:** `pnpm --filter=@opensip-tools/cli test init-refusal`

---

## Task 8.6: Integration test — uninstall safe default + no-side-effects on dry-run

**Files:** [size: M]
- Create or extend: `packages/cli/src/__tests__/uninstall-buckets.test.ts`

**Context:** Two distinct things to verify:
1. The behavior of the uninstall buckets (default vs `--purge`).
2. The **no-side-effects invariant for `--dry-run`** — confirms the lazy datastore from Phase 1.3 prevents `--dry-run --project` from creating `.runtime/` or opening SQLite. This is the assertion that catches a regression where someone reintroduces eager datastore open in preAction.

**Steps:** Use `prompt: () => Promise.resolve('y')` to bypass the interactive confirm, or `opts.yes = true`.

Bucket-behavior cases:
- Default uninstall: `.runtime/` gone, `opensip-tools.config.yml` exists, `opensip-tools/fit/checks/my.mjs` exists.
- `--purge`: everything gone.
- Default uninstall prints `These will be KEPT` section with the user content listed.
- `--purge` prints `⚠ This removes EVERYTHING` + the git-status hint.
- `--dry-run` (default mode): nothing deleted, dry-run output matches default-mode shape.
- `--dry-run --purge`: nothing deleted, dry-run output matches purge-mode shape.
- **Bucket invariant case:** create a project with `opensip-tools/notes/` (a user-created dir that the previous draft would have missed). Run `--dry-run` (default). Assert the printer lists `notes/` in the "KEPT" block — proves the bucket logic is "everything but .runtime/", not an enumeration.

No-side-effects cases (new):
- Set up a tmp project. Run `uninstall --project --dry-run --yes`. Assert no SQLite file at `<root>/opensip-tools/.runtime/datastore.sqlite` after the run. (Lazy datastore from Phase 1.3.)
- Pre-delete `.runtime/` before the dry-run. Run `uninstall --project --dry-run --yes`. Assert `.runtime/` still doesn't exist after the dry-run. (preAction didn't recreate it.)
- Same setup, but `uninstall --project --purge --dry-run`. Same assertion — even purge mode's dry-run is filesystem-clean.

**Verification:** `pnpm --filter=@opensip-tools/cli test uninstall-buckets`

---

## Task 8.7: Integration test — schemaVersion skew error

**Files:** [size: S]
- Create: `packages/cli/src/__tests__/schema-version-skew.test.ts`

**Context:** Subprocess spawn with a fabricated config. The skew check exits the process; that's testable via exit code.

**Steps:** Cases:
- Config `schemaVersion: 99` → CLI exits 2 with the **upgrade-CLI** message on stderr (containing `npm install -g @opensip-tools/cli@latest`). Verify the message does NOT mention "migrate" — that was the bug in the original draft of the messaging.
- Config missing `schemaVersion` → CLI proceeds normally (existing user configs).
- Config `schemaVersion: 1` → CLI proceeds normally.
- Config with `schemaVersion: 0` → CLI proceeds normally (permissive reader clamps to 1).
- Config with `schemaVersion: 0` rendered as `"schemaVersion": "1"` (string instead of number) → CLI proceeds normally as v1 (permissive).

**Verification:** `pnpm --filter=@opensip-tools/cli test schema-version-skew`

---

## Task 8.8: Update existing tests broken by the uninstall default change

**Files:** [size: M]
- Modify: any existing test in `packages/cli/src/__tests__/uninstall*.test.ts` that asserts the old "removes user content by default" behavior

**Context:** Phase 5's default change will break tests that assumed the old destructive default. Audit those tests and rewrite: assertions about "removes user content" must move to the `--purge` path; the default path's assertions become "preserves user content + removes .runtime/."

**Steps:** Audit, rewrite, run.

**Verification:** `pnpm --filter=@opensip-tools/cli test uninstall`

---

## Phase 8 End-to-End Verification

```bash
pnpm test
```

All tests pass. Coverage report should show new modules (`project-root.ts`, `config-version.ts`, `phantom-detect.ts`, `project-header.ts`) at ≥95% branch coverage.

> **Deferred:** Vitest pattern review (e.g. consistency with the project's mock/fixture conventions, naming patterns, integration-test classification) was the responsibility of plan-improvements Phase 10. Apply common sense + match the patterns in `packages/cli/src/__tests__/e2e.test.ts`.
