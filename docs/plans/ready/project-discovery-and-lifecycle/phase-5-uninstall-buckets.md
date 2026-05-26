# Phase 5: Uninstall buckets + docs

**Goal:** Refactor `uninstall --project` into a two-bucket model with the broadest-possible "user content" invariant: `.runtime/` is the only "delete-by-default" bucket. Everything else under `opensip-tools/` (custom checks, recipes, scenarios, future-tool dirs, user-created folders) is preserved unless `--purge`. Update README + CHANGELOG in lockstep.
**Depends on:** Phase 3

**Breaking change:** `uninstall --project`'s default behavior changes. Old default: destructive (removes user content + config + runtime). New default: safe (runtime only). Users who scripted the old behavior add `--purge`. CHANGELOG entry required. README updated.

---

## Task 5.1: Add bucket classification to `collectTargets`

**Files:** [size: M]
- Modify: `packages/cli/src/commands/uninstall.ts`

**Context:** `collectTargets` (line 147) today returns an undifferentiated `Target[]`. The refactor classifies each target into one of three buckets:

- `'runtime'` — `<userSourceDir>/.runtime/` only. Rebuildable. Removed by default.
- `'user-content'` — `<userSourceDir>` minus `.runtime/`. Everything else under `opensip-tools/`. Kept unless `--purge`.
- `'config'` — `<configFile>`. Project config. Kept unless `--purge`.

The invariant for `user-content` is **"everything under `opensip-tools/` other than `.runtime/`"** — NOT an enumeration of `fit/`, `sim/`, etc. This is the corrected version from the review: future tools (audit, lint, bench) and user-created folders (`opensip-tools/notes/`, `opensip-tools/custom-stuff/`) all benefit without needing per-tool updates here.

Display is a separate concern: for the customer-visible printout we still want to *list* the subdirectories so they know what's being preserved. But the *invariant* is "everything not in `.runtime/`."

**Steps:**

1. Update the `Target` type:

   ```ts
   type TargetBucket = 'runtime' | 'user-content' | 'config' | 'user-level';

   interface Target {
     readonly path: string;
     readonly kind: 'file' | 'dir';
     readonly sizeBytes: number;
     readonly bucket: TargetBucket;
     /** For user-content children: relative label like 'fit/checks' or 'notes'. */
     readonly displayLabel?: string;
     /** For user-content children that are dirs: count of files inside (top-level). */
     readonly fileCount?: number;
   }
   ```

2. Rewrite `collectTargets` for project mode:

   ```ts
   function collectTargets(mode: UninstallMode, root: string, opts: UninstallOptions): Target[] {
     if (mode === 'user') {
       if (!existsSync(root)) return [];
       return [{ path: root, kind: 'dir', sizeBytes: dirSize(root), bucket: 'user-level' }];
     }

     const paths = resolveProjectPaths(resolveProjectDir(opts));
     const targets: Target[] = [];

     // Bucket 1: runtime (always-safe-to-delete)
     if (existsSync(paths.runtimeDir)) {
       targets.push({
         path: paths.runtimeDir,
         kind: 'dir',
         sizeBytes: dirSize(paths.runtimeDir),
         bucket: 'runtime',
       });
     }

     // Bucket 2: user-authored content under opensip-tools/, EXCLUDING .runtime/.
     // Enumerate every top-level entry under userSourceDir that isn't .runtime so
     // the customer can see what's being preserved. This is display only — the
     // INVARIANT is "everything but .runtime/," not "only the known subdirs."
     if (existsSync(paths.userSourceDir)) {
       const entries = readdirSync(paths.userSourceDir, { withFileTypes: true });
       for (const entry of entries) {
         if (entry.name === '.runtime') continue;
         const path = join(paths.userSourceDir, entry.name);
         const sizeBytes = entry.isDirectory() ? dirSize(path) : statSync(path).size;
         targets.push({
           path,
           kind: entry.isDirectory() ? 'dir' : 'file',
           sizeBytes,
           bucket: 'user-content',
           displayLabel: entry.name,  // e.g. 'fit', 'sim', 'notes', '.gitignore'
           fileCount: entry.isDirectory() ? countFilesRecursive(path) : undefined,
         });
       }
     }

     // Bucket 3: top-level config file
     if (existsSync(paths.configFile)) {
       targets.push({
         path: paths.configFile,
         kind: 'file',
         sizeBytes: statSync(paths.configFile).size,
         bucket: 'config',
       });
     }

     return targets;
   }

   function countFilesRecursive(dir: string): number {
     let count = 0;
     const walk = (d: string): void => {
       for (const entry of readdirSync(d, { withFileTypes: true })) {
         const p = join(d, entry.name);
         if (entry.isDirectory()) walk(p);
         else if (entry.isFile()) count++;
       }
     };
     try { walk(dir); } catch { /* unreadable subdir — best-effort count */ }
     return count;
   }
   ```

   Note: the `--purge` mode operates on the full target list; the default mode filters to `bucket === 'runtime'` (Task 5.3 wires this).

3. Update `executeUninstall` (line 208):

   ```ts
   const allTargets = collectTargets(mode, userRoot, opts);
   const targetsToDelete = mode === 'project' && !opts.purge
     ? allTargets.filter((t) => t.bucket === 'runtime')
     : allTargets;
   const targetsToKeep = mode === 'project' && !opts.purge
     ? allTargets.filter((t) => t.bucket !== 'runtime')
     : [];
   ```

4. Pass both lists into `printTargets` (Task 5.3).

5. The destructive loop at line 247 now iterates `targetsToDelete` (renamed from `targets`).

**Wiring:** Bucket classification in `collectTargets` → filter in `executeUninstall` → print + delete.

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli build && pnpm --filter=@opensip-tools/cli typecheck
```

**Commit:** `refactor(cli): classify uninstall targets into runtime/user-content/config buckets`

---

## Task 5.2: Add `--purge` flag

**Files:** [size: XS]
- Modify: `packages/cli/src/commands/uninstall.ts` (and Commander registration site)

**Steps:**

1. Extend `UninstallOptions` with `readonly purge?: boolean`.
2. Find the `program.command('uninstall').option(...)` registration (in `uninstall.ts` itself or `commands/index.ts`) and add:

   ```ts
   .option('--purge', 'with --project, also remove user-authored content and config (destructive)')
   ```

3. Wire `purge: opts.purge as boolean | undefined` into the options struct passed to `executeUninstall`.

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli build && pnpm --filter=@opensip-tools/cli typecheck
```

**Commit:** `feat(cli): add --purge flag to uninstall`

---

## Task 5.3: New copy — default and `--purge` modes

**Files:** [size: M]
- Modify: `packages/cli/src/commands/uninstall.ts`

**Context:** `printTargets` (line 167) currently prints one flat block. Two branches now: safe default (shows "will remove" + "will be KEPT") and `--purge` (full destructive list + git hint).

**Steps:**

1. Rewrite `printTargets` and add helpers:

   ```ts
   function printTargets(
     write: (s: string) => void,
     mode: UninstallMode,
     toDelete: readonly Target[],
     toKeep: readonly Target[],
     purge: boolean,
     projectRoot: string,
   ): void {
     if (mode === 'user') {
       printUserTargets(write, toDelete);
       return;
     }
     if (purge) {
       printProjectTargetsPurge(write, toDelete, projectRoot);
     } else {
       printProjectTargetsDefault(write, toDelete, toKeep, projectRoot);
     }
   }

   function printProjectTargetsDefault(
     write: (s: string) => void,
     toDelete: readonly Target[],
     toKeep: readonly Target[],
     projectRoot: string,
   ): void {
     write(`\n`);
     write(`Project: ${projectRoot}\n\n`);
     if (toDelete.length > 0) {
       write(`This will remove (rebuildable runtime state only):\n`);
       for (const t of toDelete) {
         write(`  - ${formatTargetPath(t)}                              ${formatSize(t.sizeBytes)}\n`);
         if (t.bucket === 'runtime') {
           write(`    sessions database, cache, logs, baselines\n`);
         }
       }
     } else {
       write(`Nothing to remove — runtime state is already absent.\n`);
     }
     if (toKeep.length > 0) {
       write(`\nThese will be KEPT (your authored content):\n`);
       for (const t of toKeep) {
         write(`  ✓ ${formatKeepLine(t)}\n`);
       }
       write(`\n  To also remove your authored content, re-run with --purge.\n\n`);
     } else {
       write(`\n`);
     }
   }

   function printProjectTargetsPurge(
     write: (s: string) => void,
     toDelete: readonly Target[],
     projectRoot: string,
   ): void {
     write(`\n`);
     write(`Project: ${projectRoot}\n\n`);
     write(`⚠ This removes EVERYTHING, including your authored content:\n\n`);
     for (const t of toDelete) {
       write(`  - ${formatTargetPath(t)}                              ${formatSize(t.sizeBytes)}\n`);
     }
     write(`\n  ⚠ If your custom checks are not committed to git, you will\n`);
     write(`    lose them. We recommend running \`git status\` first.\n\n`);
   }

   function formatKeepLine(t: Target): string {
     if (t.bucket === 'config') return `opensip-tools.config.yml`;
     if (t.displayLabel === undefined) return relativeToProject(t.path);
     const inner = t.fileCount !== undefined
       ? ` (${t.fileCount} file${t.fileCount === 1 ? '' : 's'})`
       : '';
     return `opensip-tools/${t.displayLabel}${t.kind === 'dir' ? '/' : ''}${inner}`;
   }
   ```

   (Adapt path-formatting + alignment to existing project style; `relativeToProject` is one helper to write.)

2. Update the prompt call site (~line 240) to pass the new arguments. The `confirm` prompt text stays the same; pre-prompt printing is the printer's responsibility now.

3. Delete the existing line 230–233 note (`Note: this removes user-authored content…`) — the new printer expresses this with structure.

4. Audit existing copy in error paths (e.g. the "Nothing to remove" message at line 222) — update wording so it's consistent with the new printer's voice.

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli build && pnpm --filter=@opensip-tools/cli typecheck && \
pnpm --filter=@opensip-tools/cli test uninstall
```

Manual smoke (TempDir + init + populate `.runtime/`):

```bash
TMPDIR=$(mktemp -d) && cd "$TMPDIR" && \
  node /path/to/cli/dist/index.js init && \
  node /path/to/cli/dist/index.js fit --json > /dev/null && \
  node /path/to/cli/dist/index.js uninstall --project --dry-run
# Expected: "This will remove (rebuildable runtime state only)" + "These will be KEPT"
```

And:

```bash
node /path/to/cli/dist/index.js uninstall --project --purge --dry-run
# Expected: "⚠ This removes EVERYTHING" + git-status hint
```

**Commit:** `feat(cli): uninstall split into safe default + --purge with new copy`

---

## Task 5.4: Update README

**Files:** [size: S]
- Modify: `README.md`

**Context:** `README.md:674` currently reads:

> Project-mode uninstall removes user-authored content (custom checks, recipes) alongside the gitignored `.runtime/` state — git history is the safety net.

That's exactly the behavior Phase 5 changes. The README must update in lockstep or customers reading the docs will be misled.

The state-table at line 685+ should also reflect the new default behavior.

**Steps:**

1. Rewrite the paragraph at line 674:

   ```markdown
   Project-mode uninstall removes only the rebuildable `.runtime/` state by default. Your authored content (custom checks, recipes, scenarios) and `opensip-tools.config.yml` are preserved.

   To remove everything — including authored content and the config — pass `--purge`. `--purge` is destructive: if your custom checks aren't committed to git, you'll lose them. We recommend running `git status` first.

   Both modes refuse to run when neither `opensip-tools/` nor `opensip-tools.config.yml` exists at the resolved path, so an accidental `--project /unrelated/dir` is a no-op rather than a destructive accident.
   ```

2. Update the state-table at line 685+:

   ```markdown
   | Path | Tracked by git? | Removed by default | Removed by `--purge` |
   |---|---|---|---|
   | `~/.opensip-tools/config.yml` | no — user-level | `opensip-tools uninstall` (user mode) | — |
   | `<project>/opensip-tools.config.yml` | yes — project config | (kept) | `opensip-tools uninstall --project --purge` |
   | `<project>/opensip-tools/.runtime/` | no — runtime state | `opensip-tools uninstall --project` | `opensip-tools uninstall --project --purge` |
   | `<project>/opensip-tools/<user-content>/` | yes — user-authored | (kept) | `opensip-tools uninstall --project --purge` |
   ```

3. If `README.md` has a section showing example output, update it to match the new printer's copy from Task 5.3.

**Verification:**

```bash
# Visual review — the markdown should render cleanly. Run a markdown linter if one's configured:
grep -n "git history is the safety net" README.md
# Expected: no matches (old phrasing gone).
```

**Commit:** `docs(readme): uninstall now keeps user content by default; document --purge`

---

## Task 5.5: Add CHANGELOG entry

**Files:** [size: XS]
- Modify: `CHANGELOG.md`

**Context:** The default behavior of `uninstall --project` changes. Per semver, this is a breaking change at the CLI surface. Document it.

**Steps:**

1. Add an entry under the next-release section of `CHANGELOG.md`:

   ```markdown
   ### Breaking

   - `opensip-tools uninstall --project` no longer removes user-authored content by default. The new default removes only `opensip-tools/.runtime/` (rebuildable state); user-authored content under `opensip-tools/` and `opensip-tools.config.yml` are preserved. To restore the previous destructive behavior, pass `--purge`. Rationale: the previous default was actively dangerous — see the "git history is your safety net" note that this release removes.

   ### Added

   - `--purge` flag on `opensip-tools uninstall --project` for the destructive mode.
   - Project-root discovery: commands run from a subdirectory now find the project root by walking up to the nearest `opensip-tools.config.yml`. Phantom-scaffold bug fixed.
   - `ℹ Project: <path>` header prepended to project-scoped commands. Suppressed for `--json`, `completion`, `--help`, `--version`, user-scoped commands.
   - `schemaVersion: 1` field in `opensip-tools.config.yml`. The CLI errors with a clear "upgrade your CLI" message when the config schema is newer than the CLI supports.
   ```

2. If the CHANGELOG follows a specific format (Keep-a-Changelog, conventional commits), match it.

**Verification:** N/A.

**Commit:** `docs(changelog): document uninstall default change + discovery + schemaVersion`

---

## Phase 5 End-to-End Verification

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

After this phase:
- `uninstall --project` default → only `.runtime/` removed; everything else under `opensip-tools/` preserved including future-tool dirs and user-created folders.
- `uninstall --project --purge` → everything removed with warning + git-status hint.
- `uninstall --user` → unchanged.
- README + CHANGELOG reflect new behavior.
- Existing tests asserting the OLD destructive default are updated (Phase 8 owns those rewrites).

> **Deferred:** A `--dry-run --json` mode that emits structured bucket info would help script users; out of scope here.
