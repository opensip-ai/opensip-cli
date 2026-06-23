# Tool live view recipe

ADR-0058 splits live-run rendering into two packages:

- **`@opensip-cli/cli-ui`** — presentational shell (`<LiveRun>`, progress surfaces,
  `liveRunTable`). Plain data only; no `core` or `contracts` imports.
- **`@opensip-cli/cli-live`** — runtime glue (`runToolLiveView`): loading →
  running → done | error state machine, session/envelope capture, exit-code
  handling, and the `produce()` seam tools implement.

Tool engines (`fit`, `graph`, `sim`, `yagni`) must **never** import `render`
from `ink`. The `live-view-through-cli-live` fitness check enforces this.

## Wiring a new tool

1. **Register a live view** on the tool descriptor (`registerLiveView` in
   `tool.ts`). The host calls it on a TTY; non-TTY paths still use the static
   `RunPresentation` seam.

2. **Implement `renderMyToolLive`** in `cli/my-tool-runner.tsx`:

   ```typescript
   import { runToolLiveView } from '@opensip-cli/cli-live';
   import { currentScope, type LiveViewContext, type ToolCliContext } from '@opensip-cli/core';

   export async function renderMyToolLive(
     args: MyToolArgs,
     cli: ToolCliContext,
     liveContext?: LiveViewContext,
   ) {
     return runToolLiveView(
       {
         tool: 'mytool',
         meta: { title: 'My Tool', description: 'Running analysis...' },
         surface: { shape: 'pool', label: 'Working...' },
         verbose: args.verbose === true,
         quiet: args.quiet === true,
         projectPath: args.cwd,
         walkedUp: currentScope()?.projectContext?.walkedUp,
         produce: async (emit, helpers) => {
           emit({ type: 'stage-start', stage: 'work', label: 'Running...' });
           helpers.setRunning((cb) => {
             /* subscribe worker or in-process progress to cb */
           });

           const outcome = await runMyEngine(args, cli, {
             onProgress: (completed, total) =>
               emit({ type: 'stage-progress', stage: 'work', completed, total }),
           });

           if (outcome.error) {
             return { kind: 'error', message: outcome.message, exitCode: outcome.exitCode };
           }

           return {
             kind: 'done',
             done: {
               summary: {
                 passed: outcome.envelope.verdict.passed,
                 errors: outcome.envelope.verdict.summary.errors,
                 warnings: outcome.envelope.verdict.summary.warnings,
               },
               ...(args.verbose
                 ? { table: myRowsToLiveRunTable(outcome.envelope) }
                 : {}),
             },
             envelope: outcome.envelope,
             session: outcome.session,
           };
         },
       },
       { liveContext },
     );
   }
   ```

3. **Map engine output to `LiveRunDoneData`**:
   - `summary` always comes from `envelope.verdict`.
   - `verboseLines` / `verboseFindings` / `table` are **verbose-only** surfaces
     (compact TTY runs show summary + footer only).
   - Use `liveRunTable` from `@opensip-cli/cli-ui` for per-unit tables; map
     envelope units to `LiveRunTableRow` in the tool package (do not import
     `@opensip-cli/output` or the CLI host's `envelopeTableNode`).

4. **Off-thread workers** (`fit`, `graph`, `sim`): call
   `runOffThreadOrInProcess` inside `produce`, pass `helpers.setRunning(run.onProgress)`,
   and await `run.result`. YAGNI runs in-process and wires progress through
   `emit()` directly.

5. **Return `ToolSessionContribution`** on the done branch; the host stamps
   timing and persists the session row (tools never write `StoredSession` timing
   columns directly).

## Observability

`runToolLiveView` logs structured events through the scoped logger:

- `cli.liveview.run.start` — `{ tool }`
- `cli.liveview.run.complete` — `{ tool }`
- `cli.liveview.run.error` — `{ tool, message }` (scrubbed + truncated)

## Layer placement

| Package | Layer | May import |
|---------|-------|------------|
| `cli-ui` | 2 | React, Ink primitives only |
| `cli-live` | 3 | `core`, `cli-ui`, `contracts` (types) |
| tool engines | 4 | `cli-live`, `cli-ui`, `core`, `contracts` |

See [architecture-map.md](/docs/opensip-cli/80-implementation/architecture-map/) and
[ADR-0058](https://github.com/opensip-ai/opensip-cli/blob/v0.1.11/docs/decisions/ADR-0058-shared-live-run-shell.md).