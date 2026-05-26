# Phase 4: Init refusal

**Goal:** When `opensip-tools init` is invoked inside an existing project without an explicit `--cwd` flag, refuse with a three-option message that hands the user copy-paste-ready next actions. The `--cwd .` escape hatch preserves intentional nested-project creation.
**Depends on:** Phase 3

---

## Task 4.1: Add the refusal discriminator to `InitResult` in contracts

**Files:** [size: XS]
- Modify: `packages/contracts/src/types.ts`

**Context:** `InitResult` is the shared contract type at `packages/contracts/src/types.ts:273`. Per the prior plan-review feedback, it does NOT live in `init.ts` (an earlier draft of this plan said it did — that was wrong). New refusal states must be expressed here so the renderer (`InitFeedback.tsx`, Task 4.3) and any JSON consumers see the same shape.

**Steps:**

1. After the `state` field declaration (line 285+) and before `languages`, add an optional discriminator:

   ```ts
   /**
    * Set when init refused because the user invoked it from inside an
    * existing project without an explicit `--cwd` flag. Carries the
    * discovered root path and the rendered message — the message text
    * is computed in init.ts so JSON consumers (`--json`) get the same
    * string the human-readable renderer prints.
    */
   readonly insideExistingProject?: {
     readonly discoveredRoot: string;
     readonly message: string;
   };
   ```

2. Confirm the field's optionality keeps the existing test suite green (`pnpm --filter=@opensip-tools/contracts test`). It's optional, so absent in every existing init result. New code paths set it.

**Wiring:** Pure type addition. Phase 4.2 populates it; Phase 4.3 reads it from the renderer.

**Verification:**
```bash
pnpm --filter=@opensip-tools/contracts build && pnpm --filter=@opensip-tools/contracts typecheck
```

**Commit:** `feat(contracts): add insideExistingProject discriminator to InitResult`

---

## Task 4.2: Detect "init inside existing project" and produce the refusal result

**Files:** [size: M]
- Modify: `packages/cli/src/commands/init.ts`

**Context:** Today `executeInit` (line 878) classifies the working dir (`classifyWorkingDir` line 479) and applies the `--keep` / `--remove` mutex (lines 880–905). Phase 4 adds an *upstream* refusal that fires BEFORE classification when:

- `args.project.scope === 'project'` (discovery found a config above), AND
- `args.project.projectRoot !== args.cwd` (we're below it, not at it), AND
- `args.project.cwdExplicit === false` (user did NOT pass `--cwd`).

If the user passes `--cwd <path>` (including `--cwd .`), `cwdExplicit` is true and the refusal does not fire. This is the documented escape hatch.

The refusal message uses the discovered root path in the action commands it suggests. The user copy-pastes straight from the message.

Note: `args.project` here is the CliArgs-shape field populated from `opts.projectContext` by the Commander action callback in `packages/cli/src/commands/register-init.ts` (per the naming summary in Phase 3). The tool-internal args uses `project` because there's no `--project` flag collision inside init's own command.

**Steps:**

1. At the top of `executeInit`, before computing `paths`:

   ```ts
   const project = args.project;

   if (
     project.scope === 'project' &&
     project.projectRoot !== args.cwd &&
     !project.cwdExplicit
   ) {
     const message = formatInsideExistingProjectMessage(project.projectRoot);
     return {
       type: 'init' as const,
       path: '', // no scaffold target — we refused
       cwd: args.cwd,
       configFilename: 'opensip-tools.config.yml',
       created: false,
       insideExistingProject: {
         discoveredRoot: project.projectRoot,
         message,
       },
     };
   }
   ```

2. Add the message formatter near other formatting helpers in the file:

   ```ts
   function formatInsideExistingProjectMessage(discoveredRoot: string): string {
     return [
       `✗ This directory is already inside an opensip-tools project:`,
       `    ${discoveredRoot}`,
       `    (config: opensip-tools.config.yml)`,
       ``,
       `  What did you want to do?`,
       ``,
       `    • Re-scaffold examples, keep your custom files:`,
       `        opensip-tools init --keep --cwd ${discoveredRoot}`,
       ``,
       `    • Reset the existing project (delete everything, start over):`,
       `        opensip-tools init --remove --cwd ${discoveredRoot}`,
       ``,
       `    • Create a NEW separate project here (rare — only for`,
       `      truly independent sub-projects in a monorepo):`,
       `        opensip-tools init --cwd .`,
     ].join('\n');
   }
   ```

3. Emit a structured log line for analytics:

   ```ts
   logger.info({
     evt: 'cli.init.refused',
     module: 'cli:init',
     reason: 'inside-existing-project',
     cwd: args.cwd,
     discoveredRoot: project.projectRoot,
     walkedUp: project.walkedUp,
   });
   ```

   (Place this just before the `return` block above so it fires on the refusal path.)

**Wiring:** `args.project` is populated by Phase 3.1. The refusal fires before any path/file resolution, so no filesystem writes happen on a refused init.

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli build && pnpm --filter=@opensip-tools/cli typecheck
```

Manual smoke from a subdirectory of this repo:

```bash
pnpm build
cd packages/cli && node ../../packages/cli/dist/index.js init
# Expected: exit code 2; the refusal message printed
```

With explicit `--cwd .`:

```bash
cd packages/cli && node ../../packages/cli/dist/index.js init --cwd .
# Expected: proceeds normally (escape hatch) — may refuse for OTHER reasons (e.g. partial-state)
```

**Commit:** `feat(cli): refuse init inside existing project; offer three actions`

---

## Task 4.3: Render the refusal in `InitFeedback.tsx`

**Files:** [size: S]
- Modify: `packages/cli/src/ui/components/InitFeedback.tsx`

**Context:** Per the review correction, the init UI lives at `packages/cli/src/ui/components/InitFeedback.tsx` (~line 42 of that file), NOT in any `bootstrap/render.ts`. The component already branches on `InitResult`'s discriminator fields (`state`, `partialStateError`, etc.). Adding the refusal branch fits the existing pattern.

The renderer must:
1. Detect `result.insideExistingProject !== undefined`.
2. Render `result.insideExistingProject.message` verbatim (it's already formatted with newlines and bullets).
3. Set the appropriate exit code (2) via the same plumbing other refusal states use.

**Steps:**

1. Read `packages/cli/src/ui/components/InitFeedback.tsx` to understand the current branching style. Locate the `partialStateError` rendering branch (or whichever existing refusal branch the file has). The new branch mirrors its structure.

2. Add a conditional render for `result.insideExistingProject`:

   ```tsx
   if (result.insideExistingProject) {
     return (
       <Box flexDirection="column">
         <Text>{result.insideExistingProject.message}</Text>
       </Box>
     );
   }
   ```

   (Adapt to the file's existing component style — `Static`, `<Box>`, color theming from `theme.ts`, etc.)

3. The exit code is set OUTSIDE the renderer — find where partial-state errors set exit code 2 (search the file for `setExitCode(2)` or the `EXIT_CODES.PARTIAL_STATE` reference). The refusal branch sets exit code via the same path.

4. If `--json` is in effect, the JSON renderer (a sibling code path, not `InitFeedback.tsx`) needs to emit the result as JSON with the `insideExistingProject` field populated. Find the JSON-mode path for init (search for `emitJson` near init result handling) and verify it serializes the new field. Likely no change needed — JSON.stringify already handles it.

**Wiring:** `InitFeedback.tsx` is the existing UI branch for init results; exit code is set at the action callback layer. Both already exist; this task just extends them.

**Verification:**
```bash
pnpm --filter=@opensip-tools/cli build && pnpm --filter=@opensip-tools/cli test InitFeedback
```

**Commit:** `feat(cli): render init refusal message in InitFeedback`

---

## Phase 4 End-to-End Verification

```bash
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

After this phase:
- `opensip-tools init` from a subdir of an initialized project → refuses with the three-option message, exit 2.
- `opensip-tools init --cwd .` from a subdir → proceeds (escape hatch).
- `opensip-tools init` from a fresh tmpdir with no parent project → scaffolds as today (`args.project.scope === 'none'`).
- `opensip-tools init --keep` from the repo root → behaves as today (`projectRoot === cwd`, refusal predicate false).
- `opensip-tools init --json` from a subdir → emits `{ "type": "init", "created": false, "insideExistingProject": { ... } }` to stdout, exit 2.

> **Deferred:** Copy review on the refusal message text. The wording is the customer-facing artifact most worth scrutinising; mockup is wired in here as starting copy, flagged for human review.
