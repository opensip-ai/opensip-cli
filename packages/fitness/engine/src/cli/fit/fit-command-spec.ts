/**
 * fit-command-spec — the declarative `fit` command (release 2.11.0 Phase 4).
 *
 * Replaces fitness's hand-rolled `registerFitCommand()` body: the host mounts
 * this spec via `mountCommandSpec`, applies the ADR-0021 common flags + fit's
 * own options, and invokes {@link runFit}. The tool no longer touches Commander.
 *
 * `output: 'raw-stream'` because fit's handler owns its entire output surface —
 * it dispatches at runtime between five mutually-exclusive modes (gate / list /
 * recipes / json / live), each of which performs its OWN render/emit, exit-code
 * decision, cloud egress (`deliverSignals` / `--report-to`), and dashboard
 * auto-open. None of that is expressible through the `signal-envelope` dispatch
 * arm (which only does `emitEnvelope`/`render`), so the host renders nothing and
 * the handler stays authoritative — byte-identical to the former action body.
 */

import { defineCommand } from '@opensip-cli/core';

import {
  runGateMode,
  runJsonMode,
  runListMode,
  runLiveMode,
  runRecipesMode,
  runShowMode,
} from '../fit-modes.js';

import type { FitOptions } from '@opensip-cli/contracts';
import type { CommandSpec, ToolCliContext, ToolRunCompletion } from '@opensip-cli/core';

// Live-view key fitness contributes to the CLI's renderer registry. Owned by
// this package — the CLI dispatcher does NOT key off this literal; each tool
// decides its own live-view name. The renderer is registered lazily inside the
// live branch of the handler via `setUpFitLiveView` (the tool wires that up).
export const FIT_LIVE_VIEW_KEY = 'fit';

/**
 * The `fit` command handler — the former `registerFitCommand()` action body,
 * lifted verbatim to a spec handler. Returns `void`: the host (`raw-stream`)
 * renders nothing, so the five-mode dispatch keeps full ownership of its IO.
 *
 * The live-view registration that previously happened as a mount-time side
 * effect in `register()` now happens lazily — the host calls `setUpFitLiveView`
 * (passed in by the tool) the first time a live run needs it. We thread that
 * setup callback in via the closure the tool builds, so this handler module
 * stays free of the `cli.registerLiveView` wiring (which belongs next to the
 * renderer import in tool.ts).
 */
async function runFit(
  rawOpts: unknown,
  cli: ToolCliContext,
  setUpLiveView: (cli: ToolCliContext) => void,
): Promise<ToolRunCompletion | void> {
  const opts = rawOpts as FitOptions;
  // host-owned-run-timing Phases 3 + 5: the run-producing modes RETURN a
  // `{ session, dashboard }` completion; runFit forwards it as a
  // ToolRunCompletion and the host run plane persists the session row AND the
  // per-run dashboard contribution after this handler resolves (the TTY live
  // path already persisted via renderLive, so it returns undefined — no
  // double-write).
  if (opts.show !== undefined && opts.show.length > 0) {
    await runShowMode(opts, cli);
    return;
  }
  if (opts.gateSave === true || opts.gateCompare === true) {
    return await runGateMode(opts, cli);
  }
  if (opts.list) {
    await runListMode(opts, cli);
    return;
  }
  if (opts.recipes) {
    await runRecipesMode(opts, cli);
    return;
  }
  if (opts.json) {
    return await runJsonMode(opts, cli);
  }
  // Live mode is the only branch that needs fitness's Ink renderer. Register it
  // lazily here (idempotent map write) — the spec-mounted world has no
  // mount-time `register()` hook, so we set the renderer up on the host context
  // before the `cli.renderLive` lookup inside runLiveMode.
  setUpLiveView(cli);
  return await runLiveMode(opts, cli, FIT_LIVE_VIEW_KEY, opts.open === true);
}

/**
 * Build the declarative `fit` command. The `setUpLiveView` callback is supplied
 * by the tool (tool.ts) so the `cli.registerLiveView(renderFitLive)` wiring
 * stays next to the renderer import; this module stays renderer-free.
 */
export function buildFitCommandSpec(
  setUpLiveView: (cli: ToolCliContext) => void,
): CommandSpec<unknown, ToolCliContext> {
  return defineCommand<unknown, ToolCliContext>({
    name: 'fit',
    description: 'Run fitness checks',
    // ADR-0021 cross-tool flags from the single registry: --cwd, --json,
    // --quiet, --verbose, --debug, --report-to, --api-key, --open. `cwd` is
    // seeded with process.cwd() by the mounter. fit-specific flags below.
    commonFlags: ['cwd', 'json', 'quiet', 'verbose', 'debug', 'reportTo', 'apiKey', 'open'],
    options: [
      {
        flag: '--recipe',
        value: '<name>',
        description: 'Use a named recipe (default, quick-smoke, backend, etc.)',
      },
      { flag: '--check', value: '<slug>', description: 'Run a single check by slug' },
      {
        flag: '--tags',
        value: '<tags>',
        description: 'Filter checks by tags (repeatable or comma-separated)',
        arrayDefault: [],
        parse: (val, prev) => [...(prev as string[]), val],
      },
      { flag: '--list', description: 'List available checks', default: false },
      { flag: '--recipes', description: 'List available recipes', default: false },
      {
        flag: '--exclude',
        value: '<slug>',
        description: 'Exclude check (repeatable)',
        arrayDefault: [],
        parse: (val, prev) => [...(prev as string[]), val],
      },
      {
        flag: '--config',
        value: '<path>',
        description: 'Path to opensip-cli.config.yml (overrides package.json pointer and default)',
      },
      {
        flag: '--show',
        value: '<session>',
        description: 'Replay a stored fit session by id, or latest for the latest fit session',
      },
      {
        flag: '--gate-save',
        description:
          'Architecture-gate: save current findings as baseline in the project SQLite store (mutually exclusive with --gate-compare)',
        default: false,
      },
      {
        flag: '--gate-compare',
        description:
          'Architecture-gate: compare current findings against the saved baseline; exit 1 on regression',
        default: false,
      },
    ],
    scope: 'project',
    output: 'raw-stream',
    rawStreamReason: 'runtime-render-dispatch',
    handler: (opts, cli) => runFit(opts, cli, setUpLiveView),
  });
}
