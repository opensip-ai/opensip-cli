/**
 * `fit-run-worker <specPath>` — the headless fit run forked by the live view
 * (ADR-0028). The live runner forks `node <cliScript> fit-run-worker <spec>`;
 * because it runs through the full CLI bootstrap, the language + tool registries,
 * project, and config are populated in scope exactly as a normal `fit` run — so
 * results are byte-identical (the reason this is a forked subcommand, not a
 * worker thread).
 *
 * It is headless: instead of rendering, it streams the engine's progress and its
 * final result over the fork IPC channel (`process.send`) as {@link WorkerMessage}s,
 * which the parent's subprocess transport relays to the shared `<LiveProgress>`
 * renderer. Persistence + egress stay on the parent (the engine is
 * persistence-free; Phase 2) — the worker only computes.
 *
 * Internal command — not user-facing; the live runner is its only caller.
 */

import { readFileSync } from 'node:fs';

import {
  defineCommand,
  sendWorkerIpcMessage,
  startWorkerHeartbeat,
  type CommandSpec,
  type ToolCliContext,
  type WorkerMessage,
} from '@opensip-cli/core';

import { executeFit } from './fit.js';

import type { ProgressEvent } from '@opensip-cli/cli-ui';
import type { FitOptions } from '@opensip-cli/contracts';

/** The worker's result value mirrors `executeFit`'s return — the parent handles it
 *  identically whether it ran in-process or in the forked worker. */
type FitWorkerResult = Awaited<ReturnType<typeof executeFit>>;

/** Post one IPC message to the parent (no-op when not forked). */
function send(msg: WorkerMessage<ProgressEvent, FitWorkerResult>): void {
  sendWorkerIpcMessage(msg);
}

function failureClass(error: unknown): string | undefined {
  return (error as { failureClass?: string }).failureClass;
}

/**
 * Read the {@link FitOptions} spec, run `executeFit` headless, and stream progress
 * + the final result over IPC. Never throws to the caller — a failure is sent as
 * a `{ kind: 'error' }` message so the parent's `result` promise rejects cleanly.
 */
export async function executeFitWorker(specPath: string): Promise<void> {
  const stopHeartbeat = startWorkerHeartbeat();
  try {
    const args = JSON.parse(readFileSync(specPath, 'utf8')) as FitOptions;
    send({
      kind: 'progress',
      event: { type: 'stage-start', stage: 'checks', label: 'Running checks...' },
    });
    const fitResult = await executeFit(args, {
      onProgress: (completed, total) =>
        send({
          kind: 'progress',
          event: { type: 'stage-progress', stage: 'checks', completed, total },
        }),
    });
    send({ kind: 'result', value: fitResult });
  } catch (error) {
    send({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
      ...(failureClass(error) === undefined ? {} : { failureClass: failureClass(error) }),
    });
  } finally {
    stopHeartbeat();
  }
}

/** `fit-run-worker` — [internal] headless fit run, IPC progress/result. */
export const fitRunWorkerCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'fit-run-worker',
  visibility: 'internal',
  description:
    '[internal] Run fit headless and stream progress + result over IPC (forked by the live view)',
  commonFlags: [],
  args: [{ name: 'specPath', description: 'Path to a JSON FitOptions spec file' }],
  scope: 'project',
  output: 'raw-stream',
  rawStreamReason: 'worker-ipc',
  handler: async (rawOpts): Promise<void> => {
    const specPath = (rawOpts as { _args?: readonly string[] })._args?.[0] ?? '';
    await executeFitWorker(specPath);
  },
});
