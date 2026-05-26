# Phase 2: Project header

**Goal:** Render `ℹ Project: <abs path>` before every project-scoped, human-readable command. Critical safety rule: suppress for output that gets piped into other tools (`--json`, `completion`, `--help`, `--version`) and for user-scoped commands. Verify no overlap with the existing `RunHeader` Ink component.
**Depends on:** Phase 1

---

## Task 2.0: Update `RunHeader` to render `Project:` from the resolved root

**Files:** [size: S]
- Modify: `packages/cli-ui/src/run-header.tsx`
- Modify: every caller of `RunHeader` (search the workspace for imports)

**Context:** `packages/cli-ui/src/run-header.tsx:34` currently renders `` `Target: ${cwd}` `` as part of its metadata row. That's an information line in roughly the same conceptual slot as the new `Project:` header. Per the latest review, the right answer is **not** to suppress the preAction header for commands that mount `RunHeader` (that's two policies for the same UX moment); instead, **change `RunHeader` to render `Project:` using the resolved root** and let it be the single canonical header.

The Phase 2.2 imperative header (`formatProjectHeader` written to stdout from `pre-action-hook`) then takes over for commands that don't mount an Ink view. The two channels are mutually exclusive by command shape: live-Ink commands replace stdout with Ink's render loop and the imperative line would be overwritten anyway; non-Ink commands need the imperative line because they have no Ink loop.

So the policy becomes:

- **Live-Ink commands (`fit` in its default rendered mode, `dashboard`, etc.):** `RunHeader` renders `Project: <projectRoot>` from `ctx.project`. The preAction imperative header is suppressed (Task 2.2 adds a check on whether the command will render an Ink live view; the simplest signal is the command's name).
- **Non-Ink commands (`fit-list`, `sim --dry-run`, `plugin list`, `sessions list`, `uninstall --project --dry-run`, etc.):** the preAction imperative header fires.

**Steps:**

1. Update `RunHeader`'s props to accept `projectRoot` and `walkedUp` (replacing `cwd`):

   ```tsx
   export interface RunHeaderProps {
     readonly tool: string;
     readonly description?: string;
     /** Resolved project root (from ctx.project.projectRoot). */
     readonly projectRoot: string;
     /** Ancestor steps walked. 0 == cwd is the root. */
     readonly walkedUp: number;
     readonly metadata?: ReadonlyArray<{ readonly label: string; readonly value: string }>;
   }
   ```

2. Update the `metaParts` construction (line 32–35) to render `Project: <root>` (with optional walked-up suffix) instead of `Target: <cwd>`:

   ```tsx
   const projectLine = props.walkedUp === 0
     ? `Project: ${props.projectRoot}`
     : `Project: ${props.projectRoot}  (found ${props.walkedUp} ${props.walkedUp === 1 ? 'level' : 'levels'} up)`;

   const metaParts = [
     ...metadata.map((m) => `${m.label}: ${m.value}`),
     projectLine,
   ];
   ```

3. Update every `RunHeader` caller (find with `grep -rn 'RunHeader' packages --include="*.ts" --include="*.tsx" | grep -v dist`) to pass `projectRoot` + `walkedUp` from `ctx.project` instead of `cwd`. Likely callers: `fit-runner.tsx` (fitness's live view), dashboard renderer.

4. The visible string changes from "Target: /path/to/repo" to "Project: /path/to/repo" (with the walked-up annotation when applicable). This is a customer-facing copy change to existing functionality. Flag in the Phase 5 CHANGELOG entry: "Replaced 'Target:' label with 'Project:' in fit's live header to unify with the new project-discovery header."

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli-ui build && pnpm --filter=@opensip-tools/cli-ui typecheck && \
pnpm --filter=@opensip-tools/fitness build && pnpm --filter=@opensip-tools/fitness typecheck
```

**Commit:** `refactor(cli-ui): RunHeader renders Project from resolved root (was Target: cwd)`

---

## Task 2.1: Create `formatProjectHeader` in cli-ui

**Files:** [size: S]
- Create: `packages/cli-ui/src/project-header.ts`
- Modify: `packages/cli-ui/src/index.ts`

**Context:** Skip this task if Task 2.0 concluded that `RunHeader` already does the job. Otherwise: a pure string formatter is the right shape. `pre-action-hook` is not a React context; building Ink view machinery for one line is overkill. Tools that *do* render with Ink can compose the string into their views.

**Steps:**

1. Create `packages/cli-ui/src/project-header.ts`:

   ```ts
   /**
    * Format the "Project: <abs path>" header. Pure string formatter — no
    * Ink/React, so the imperative pre-action-hook can write the result
    * directly to stdout.
    *
    * Suppression policy (enforced by the caller, not here): do not call
    * for `--json`, `completion`, `--help`, `--version`, or user-scoped
    * commands where the output is piped/sourced.
    */

   export interface ProjectHeaderInput {
     /** Absolute path to the project root. */
     readonly root: string;
     /** Ancestor steps walked. 0 == cwd is the root. */
     readonly walkedUp: number;
   }

   /**
    * Render the header line. Includes a trailing newline so callers
    * can `process.stdout.write` without thinking about line termination.
    *
    * walkedUp 0  → `ℹ Project: <root>`
    * walkedUp 1  → `ℹ Project: <root>  (found 1 level up)`
    * walkedUp N  → `ℹ Project: <root>  (found N levels up)`
    */
   export function formatProjectHeader(input: ProjectHeaderInput): string {
     const base = `ℹ Project: ${input.root}`;
     if (input.walkedUp === 0) return `${base}\n`;
     const noun = input.walkedUp === 1 ? 'level' : 'levels';
     return `${base}  (found ${input.walkedUp} ${noun} up)\n`;
   }
   ```

2. Re-export from `packages/cli-ui/src/index.ts`.

3. Glyph choice: `ℹ` is U+2139. Confirm by reading sibling files in `cli-ui/src/` to match existing glyph style (search `banner.tsx`, `error-message.tsx`, `theme.ts`). If they prefer ASCII prefixes, swap accordingly + update all mocked copy in the rest of the plan.

**Wiring:** Standalone string utility.

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli-ui build && pnpm --filter=@opensip-tools/cli-ui typecheck
```

**Commit:** `feat(cli-ui): add formatProjectHeader string formatter`

---

## Task 2.2: Mount the header in `pre-action-hook` with a suppression list

**Files:** [size: M]
- Modify: `packages/cli/src/bootstrap/pre-action-hook.ts`

**Context:** The header must NEVER appear for output that downstream tools parse or source:

- `--json` — JSON consumers can't parse "ℹ Project: …" as JSON. Existing flag.
- `completion zsh|bash|fish` — output is shell code that gets `source`'d. Free text breaks the source.
- `--help` / `--version` — convention is clean output; prepending free text is jarring for users piping help into `less` or to other tools.
- User-scoped commands (today: `configure`, `uninstall --user`) operate on `~/.opensip-tools/`, not a project; printing a project header would be misleading.

Plus: when `project.scope === 'none'`, the header would mislead the user into thinking a project was found. In that case, either suppress entirely (let the per-command "No opensip-tools project found" error speak for itself) or — better — print a different short header (`ℹ No project (running from /cwd/path)`). Pick suppression for now to keep the rule simple; the per-command error is the actionable signal.

**Steps:**

1. Add import:

   ```ts
   import { formatProjectHeader } from '@opensip-tools/cli-ui';
   ```

2. Define a suppression set at module top:

   ```ts
   /**
    * Commands and shapes for which the imperative Project: header is suppressed.
    *
    * Rationale:
    *  - JSON consumers / shell-sourced output / help-text piped elsewhere
    *    all break on free text being prepended to stdout.
    *  - Live-Ink commands ('fit' default mode, dashboard) mount RunHeader
    *    which now renders Project: itself (Task 2.0). The imperative line
    *    would be redundant and could flicker as Ink takes over the terminal.
    *
    * The set is keyed by Commander command name.
    */
   const PROJECT_HEADER_SUPPRESSED_COMMANDS: ReadonlySet<string> = new Set([
     'completion',
     'configure',
   ]);

   /**
    * Commands that render their own RunHeader inside an Ink view. The
    * imperative header suppresses for these because RunHeader is the
    * canonical project-line renderer in Ink mode.
    *
    * Note: --json mode on these commands skips Ink and goes through the
    * JSON-output path; the --json flag check below catches that case.
    */
   const COMMANDS_WITH_INK_RUN_HEADER: ReadonlySet<string> = new Set([
     'fit',
     'sim',
     'graph',
     'dashboard',
   ]);
   ```

3. After the context resolution + side-effect-setup block (Task 1.2 + 1.3), before the action returns:

   ```ts
   const cmdName = actionCommand.name();
   const isInkRunHeaderCommand = COMMANDS_WITH_INK_RUN_HEADER.has(cmdName);
   const suppressByCommand = PROJECT_HEADER_SUPPRESSED_COMMANDS.has(cmdName);
   const suppressByFlag = Boolean(opts.json) || Boolean(opts.help) || Boolean(opts.version);
   const suppressByScope = project.scope !== 'project';
   const suppressByUninstallUserMode = cmdName === 'uninstall' && !opts.project;
   const suppressForUninstallProject = cmdName === 'uninstall' && opts.project !== undefined;
   const suppressByInkHeader = isInkRunHeaderCommand && !opts.json;

   const suppress = suppressByCommand || suppressByFlag || suppressByScope ||
                    suppressByUninstallUserMode || suppressForUninstallProject ||
                    suppressByInkHeader;

   if (!suppress) {
     process.stdout.write(formatProjectHeader({
       root: project.projectRoot,
       walkedUp: project.walkedUp,
     }));
   }
   ```

   `suppressByUninstallUserMode` distinguishes `uninstall --user` from `--project`. `suppressForUninstallProject` defers to the printer in Phase 5 which owns its entire prompt block. `suppressByInkHeader` defers to `RunHeader` for Ink-rendered commands. JSON mode on those Ink commands goes through `--json` (suppressByFlag), not the Ink loop.

4. `--help` / `--version` aren't actually flags the action receives — Commander intercepts them earlier and exits without firing the action. So `opts.help` and `opts.version` shouldn't normally be truthy here. Keeping them in the predicate is belt-and-suspenders; remove them if Phase 8 testing confirms they're noise.

5. Emit a structured log line when the header is suppressed (one line, low noise — `debug` level):

   ```ts
   if (suppress) {
     logger.debug({
       evt: 'cli.header.suppressed',
       module: 'cli:bootstrap',
       runId,
       command: cmdName,
       reason: suppressByFlag ? 'json' :
               suppressByInkHeader ? 'ink-runheader' :
               suppressByCommand ? 'command' :
               suppressByScope ? 'no-project' :
               suppressForUninstallProject ? 'uninstall-printer' : 'user-mode',
     });
   }
   ```

**Wiring:** Pre-action-hook → resolve context → open datastore → emit header (conditionally) → action runs.

**Verification:**
```bash
pnpm build && pnpm typecheck && pnpm test
```

Smoke matrix (run from repo root):

| Command | Expected first line of stdout |
|---------|-------------------------------|
| `opensip-tools fit-list` | `ℹ Project: <root>` |
| `opensip-tools fit-list --json` | `[` (JSON starts) — no header |
| `opensip-tools completion zsh` | shell code begins — no header |
| `opensip-tools --help` | help text — no header |
| `opensip-tools configure ...` | (configure's own output — no header) |
| `opensip-tools uninstall --user --dry-run` | (uninstall's own output — no header) |
| `opensip-tools uninstall --project --dry-run` | `Project: <root>` (uninstall printer's own line; we don't suppress here) |

The last row's suppression is already wired in step 3 above via `suppressForUninstallProject`. Phase 5's printer owns the pre-prompt block for `uninstall --project`.

**Commit:** `feat(cli): render Project header for project-scoped commands; suppress for JSON/completion/help`

---

## Phase 2 End-to-End Verification

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

Walk through the smoke matrix above by hand. Confirm `opensip-tools completion zsh > /tmp/cmpl && zsh -n /tmp/cmpl` exits 0 (the generated completion script is syntactically valid; a prepended free-text line would break this).

> **Deferred:** A formal "machine-readable output" classification on every command (rather than per-command suppression set) would be cleaner — e.g. a `Tool.metadata.machineReadable: boolean` flag. Out of scope for this plan; revisit when the next "do we suppress X?" question comes up.
