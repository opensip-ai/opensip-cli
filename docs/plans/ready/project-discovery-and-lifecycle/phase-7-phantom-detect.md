# Phase 7: Phantom detect

**Goal:** When discovery finds a parent project root, detect any orphaned `opensip-tools/.runtime/` directories that exist between `cwd` and the discovered root (left over from pre-fix runs). Emit a one-line info message offering safe cleanup. Never auto-delete.
**Depends on:** Phase 1

---

## Task 7.1: Create `detectPhantomRuntimes` in core

**Files:** [size: S]
- Create: `packages/core/src/lib/phantom-detect.ts`
- Modify: `packages/core/src/index.ts`

**Context:** The phantom we hunt is the structural fossil of the bug: a directory whose only meaningful content is `opensip-tools/.runtime/` (no user-authored content under `opensip-tools/`). Anything else under `opensip-tools/` would be user content and out of bounds for warning. The detector walks the path between `cwd` and the discovered root and identifies these orphans.

The check is deliberately conservative: it only flags directories where `opensip-tools/` contains *exclusively* `.runtime/` (or `.runtime/` + entries beginning with `.` like `.gitignore`). Any other entry — a `fit/`, a `sim/`, a `opensip-tools.config.yml` at that level — means the directory is or might be a legitimate project, and we leave it alone.

**Steps:**

1. Create `packages/core/src/lib/phantom-detect.ts`:

   ```ts
   /**
    * Detect orphaned `opensip-tools/.runtime/` directories between `cwd`
    * and the discovered project root. These are fossils from pre-discovery
    * runs where `opensip-tools fit` was invoked from a subdirectory and
    * silently scaffolded a phantom project tree there.
    *
    * Conservative: only flag directories where `opensip-tools/` contains
    * exclusively `.runtime/` (plus optional dotfiles). Any other entry
    * is treated as legitimate user content.
    */

   import { existsSync, readdirSync, statSync } from 'node:fs';
   import { dirname, join, resolve, sep } from 'node:path';

   import { logger } from './logger.js';

   const MODULE_TAG = 'core:phantom-detect';

   /**
    * Walk every ancestor between `cwd` and `root` (exclusive of `root`,
    * inclusive of `cwd`) and return the list of paths that host a phantom
    * `opensip-tools/.runtime/`.
    */
   export function detectPhantomRuntimes(cwd: string, root: string): readonly string[] {
     const start = resolve(cwd);
     const stop = resolve(root);
     if (!start.startsWith(stop + sep) && start !== stop) {
       // cwd is not below root — nothing to scan.
       return [];
     }
     const phantoms: string[] = [];
     let dir = start;
     while (dir !== stop) {
       if (isPhantomDir(dir)) {
         phantoms.push(join(dir, 'opensip-tools'));
       }
       const parent = dirname(dir);
       if (parent === dir) break; // hit filesystem root unexpectedly
       dir = parent;
     }
     if (phantoms.length > 0) {
       logger.info({
         evt: 'cli.phantom.runtime.detected',
         module: MODULE_TAG,
         cwd: start,
         root: stop,
         phantoms,
       });
     }
     return phantoms;
   }

   function isPhantomDir(dir: string): boolean {
     const innerDir = join(dir, 'opensip-tools');
     if (!safeIsDirectory(innerDir)) return false;
     let entries: string[];
     try {
       entries = readdirSync(innerDir);
     } catch {
       return false;
     }
     // Conservative: only flag if `.runtime` is the only non-dotfile entry.
     const meaningful = entries.filter((name) => !name.startsWith('.') || name === '.runtime');
     return meaningful.length === 1 && meaningful[0] === '.runtime';
   }

   function safeIsDirectory(path: string): boolean {
     try {
       return statSync(path).isDirectory();
     } catch {
       return false;
     }
   }
   ```

2. Re-export from `packages/core/src/index.ts`:

   ```ts
   export { detectPhantomRuntimes } from './lib/phantom-detect.js';
   ```

**Wiring:** Standalone detector. Task 7.2 wires it into `pre-action-hook`.

**Verification:**
```bash
pnpm --filter=@opensip-tools/core build && pnpm --filter=@opensip-tools/core typecheck
```

**Commit:** `feat(core): add detectPhantomRuntimes for orphaned .runtime detection`

---

## Task 7.2: Wire phantom warning into `pre-action-hook`

**Files:** [size: S]
- Modify: `packages/cli/src/bootstrap/pre-action-hook.ts`

**Context:** The detector runs once per command, only when `project.scope === 'project' && project.walkedUp > 0` (discovery resolved to an ancestor). Output goes to stderr (it's a warning, not part of the command's main output). One warning per phantom found; we don't spam if there's nothing.

**Steps:**

1. Add the import:

   ```ts
   import { detectPhantomRuntimes } from '@opensip-tools/core';
   ```

2. After the schema-version check from Task 6.3 (and before the Project: header from Task 2.2 to keep the warning close to the discovery context), add:

   ```ts
   if (project.scope === 'project' && project.walkedUp > 0) {
     const phantoms = detectPhantomRuntimes(project.cwd, project.projectRoot);
     for (const phantom of phantoms) {
       process.stderr.write(
         `ℹ Detected an orphaned opensip-tools/ at:\n` +
         `    ${phantom}\n` +
         `  This is left over from running opensip-tools from this subdirectory\n` +
         `  before project-root discovery was added. Safe to delete with:\n` +
         `    rm -rf ${phantom}\n\n`
       );
     }
   }
   ```

3. The warning runs ONLY when `project.walkedUp > 0` and `project.scope === 'project'`. From the project root itself the detector cannot find a phantom by definition (cwd === projectRoot, the loop body doesn't execute). When no project was found at all (`scope === 'none'`), there's nothing to compare against and the detector is skipped entirely.

**Wiring:** Pre-action-hook → after schema-version check → before Project: header.

**Verification:**

```bash
pnpm build && pnpm typecheck
```

Manual smoke against the known phantom (the sibling opensip repo):

```bash
cd /Users/sb/Documents/Code/opensip-ai/opensip/opensip-tools/fit && \
  node /path/to/cli/dist/index.js fit 2>&1 | head -20
# Expected (after pre-fix phantom remains): stderr shows the warning pointing at
# /Users/sb/Documents/Code/opensip-ai/opensip/opensip-tools/fit/opensip-tools
# stdout continues with the normal command output
```

After the user manually runs the suggested `rm -rf`, re-running from the subdir produces no warning (phantom gone) and the fit run still works correctly (operates on the parent project, no new phantom created — Phase 1 fix).

**Commit:** `feat(cli): warn on orphaned opensip-tools subtrees below discovered root`

---

## Phase 7 End-to-End Verification

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

After this phase:
- Running from a subdir with no phantoms below: no warning.
- Running from a subdir with one phantom (the `.runtime/`-only fossil): single warning with the `rm -rf` hint.
- Running from a subdir with multiple phantoms (e.g. `subdir/opensip-tools/.runtime` and `subdir/sub2/opensip-tools/.runtime` both fossils): warning per phantom.
- Running from a subdir containing legitimate user content (e.g. `subdir/opensip-tools/fit/checks/my.mjs`): no warning, because the detector is conservative.

> **Deferred:** An interactive `opensip-tools doctor --clean-phantoms` command that performs the cleanup with confirmation. The plan's stance is warn-only — auto-deletion of anything called `opensip-tools/` (even when it looks like a fossil) is too dangerous to do without explicit user invocation. The doctor command is a separate feature.
