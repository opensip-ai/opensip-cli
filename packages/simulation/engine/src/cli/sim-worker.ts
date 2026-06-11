// @fitness-ignore-file detached-promises -- this worker's `send()` helper is synchronous (it calls process.send, which returns immediately); the name-based heuristic mistakes the floating send(...) IPC posts for promise-returning calls. The one genuine async call (executeSim) is awaited.
/**
 * `sim-run-worker <specPath>` — the headless sim run forked by the live view
 * (ADR-0028). The live runner forks `node <cliScript> sim-run-worker <spec>`;
 * because it runs through the full CLI bootstrap, the scenario registry, project,
 * and config are populated in scope exactly as a normal `sim` run (executeSim's
 * own `ensureScenariosLoaded` rebuilds the registry), so results are
 * byte-identical — the reason this is a forked subcommand, not a worker thread.
 *
 * It is headless: instead of rendering, it streams pool progress and its final
 * result over the fork IPC channel (`process.send`) as {@link WorkerMessage}s,
 * which the parent's subprocess transport relays to the shared `<LiveProgress>`
 * renderer. Persistence + egress stay on the parent (the engine is
 * persistence-free; Phase 2). Internal command — the live runner is its only caller.
 */

import { readFileSync } from 'node:fs';

import {
  defineCommand,
  type CommandSpec,
  type ToolCliContext,
  type WorkerMessage,
} from '@opensip-tools/core';

import { executeSim } from './sim.js';

import type { ProgressEvent } from '@opensip-tools/cli-ui';
import type { ToolOptions } from '@opensip-tools/contracts';

type SimWorkerArgs = ToolOptions & { readonly verbose?: boolean };
/** Mirrors `executeSim`'s return — the parent handles it identically either way. */
type SimWorkerResult = Awaited<ReturnType<typeof executeSim>>;

/** Post one IPC message to the parent (no-op when not forked). */
function send(msg: WorkerMessage<ProgressEvent, SimWorkerResult>): void {
  process.send?.(msg);
}

/**
 * Read the sim-args spec, run `executeSim` headless, and stream progress + the
 * final result over IPC. Never throws to the caller — a failure is sent as a
 * `{ kind: 'error' }` message so the parent's `result` promise rejects cleanly.
 */
export async function executeSimWorker(specPath: string): Promise<void> {
  try {
    const args = JSON.parse(readFileSync(specPath, 'utf8')) as SimWorkerArgs;
    send({
      kind: 'progress',
      event: { type: 'stage-start', stage: 'scenarios', label: 'Running scenarios...' },
    });
    const simResult = await executeSim(args, {
      onProgress: (completed, total) =>
        send({
          kind: 'progress',
          event: { type: 'stage-progress', stage: 'scenarios', completed, total },
        }),
    });
    send({ kind: 'result', value: simResult });
  } catch (error) {
    send({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    });
  }
}

/** `sim-run-worker` — [internal] headless sim run, IPC progress/result. */
export const simRunWorkerCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'sim-run-worker',
  description:
    '[internal] Run sim headless and stream progress + result over IPC (forked by the live view)',
  commonFlags: [],
  args: [{ name: 'specPath', description: 'Path to a JSON sim-args spec file' }],
  scope: 'project',
  output: 'raw-stream',
  handler: async (rawOpts): Promise<void> => {
    const specPath = (rawOpts as { _args?: readonly string[] })._args?.[0] ?? '';
    await executeSimWorker(specPath);
  },
});
