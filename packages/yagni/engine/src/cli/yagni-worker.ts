/**
 * `yagni-run-worker <specPath>` — headless YAGNI run forked by the live view.
 *
 * The worker re-enters the full CLI bootstrap, then runs the CPU-heavy detector
 * pass away from the parent Ink renderer. Progress events stream over IPC; the
 * final envelope/session returns as structured data.
 */

import { readFileSync } from 'node:fs';

import {
  defineCommand,
  getWorkerErrorFailureClass,
  sendWorkerIpcMessage,
  startWorkerHeartbeat,
  type CommandSpec,
  type ToolCliContext,
  type WorkerMessage,
} from '@opensip-cli/core';

import { executeYagni, type ExecuteYagniResult } from './execute-yagni.js';
import { loadYagniConfig } from './yagni-config.js';
import { detectorDoneEvent, detectorStartEvent } from './yagni-progress.js';

import type { YagniConfidence } from '../types/yagni-metadata.js';
import type { ProgressEvent } from '@opensip-cli/cli-ui';

interface YagniWorkerSpec {
  readonly cwd: string;
  readonly minConfidence?: YagniConfidence;
  readonly detectors?: readonly string[];
  readonly categories?: readonly string[];
  readonly includeTests?: boolean;
  readonly pathRoots?: readonly string[];
}

function send(msg: WorkerMessage<ProgressEvent, ExecuteYagniResult>): void {
  sendWorkerIpcMessage(msg);
}

export async function executeYagniWorker(specPath: string, cli: ToolCliContext): Promise<void> {
  const stopHeartbeat = startWorkerHeartbeat();
  try {
    const args = JSON.parse(readFileSync(specPath, 'utf8')) as YagniWorkerSpec;
    const config = loadYagniConfig(args.cwd);
    const result = await executeYagni(
      {
        cwd: args.cwd,
        config,
        minConfidence: args.minConfidence,
        detectors: args.detectors,
        categories: args.categories,
        includeTests: args.includeTests,
        pathRoots: args.pathRoots,
        onDetectorStart: (slug) => send({ kind: 'progress', event: detectorStartEvent(slug) }),
        onDetectorDone: (slug, durationMs) =>
          send({ kind: 'progress', event: detectorDoneEvent(slug, durationMs) }),
        onDetectorsSkipped: (slugs) => {
          for (const slug of slugs) {
            send({ kind: 'progress', event: detectorDoneEvent(slug, 0, 'skipped') });
          }
        },
      },
      cli,
    );
    send({ kind: 'result', value: result });
  } catch (error) {
    send({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
      ...(getWorkerErrorFailureClass(error) === undefined
        ? {}
        : { failureClass: getWorkerErrorFailureClass(error) }),
    });
  } finally {
    stopHeartbeat();
  }
}

export const yagniRunWorkerCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'yagni-run-worker',
  visibility: 'internal',
  description:
    '[internal] Run YAGNI headless and stream progress + result over IPC (forked by the live view)',
  commonFlags: [],
  args: [{ name: 'specPath', description: 'Path to a JSON YAGNI run spec file' }],
  scope: 'project',
  output: 'raw-stream',
  rawStreamReason: 'worker-ipc',
  handler: async (rawOpts, cli): Promise<void> => {
    const specPath = (rawOpts as { _args?: readonly string[] })._args?.[0] ?? '';
    await executeYagniWorker(specPath, cli);
  },
});
