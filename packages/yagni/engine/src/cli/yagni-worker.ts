/**
 * `yagni-run-worker <specPath>` — headless YAGNI run forked by the live view.
 *
 * The worker re-enters the full CLI bootstrap, then runs the CPU-heavy detector
 * pass away from the parent Ink renderer. Progress events stream over IPC; the
 * final envelope/session returns as structured data.
 */

import {
  defineCommand,
  runJsonSpecWorker,
  type CommandSpec,
  type ToolCliContext,
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

function runYagniWorkerSpec(
  args: YagniWorkerSpec,
  emit: (event: ProgressEvent) => void,
): Promise<ExecuteYagniResult> {
  const config = loadYagniConfig(args.cwd);
  return executeYagni({
    cwd: args.cwd,
    config,
    minConfidence: args.minConfidence,
    detectors: args.detectors,
    categories: args.categories,
    includeTests: args.includeTests,
    pathRoots: args.pathRoots,
    onDetectorStart: (slug) => emit(detectorStartEvent(slug)),
    onDetectorDone: (slug, durationMs) => emit(detectorDoneEvent(slug, durationMs)),
    onDetectorsSkipped: (slugs) => {
      for (const slug of slugs) emit(detectorDoneEvent(slug, 0, 'skipped'));
    },
  });
}

export async function executeYagniWorker(specPath: string, _cli?: ToolCliContext): Promise<void> {
  await runJsonSpecWorker<YagniWorkerSpec, ProgressEvent, ExecuteYagniResult>({
    specPath,
    run: runYagniWorkerSpec,
  });
}

export const yagniRunWorkerCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  staticHandler: {
    package: '@opensip-cli/yagni',
    path: 'packages/yagni/engine/src/cli/yagni-worker.ts',
    declaration: 'yagniRunWorkerCommandSpec',
  },
  name: 'yagni-run-worker',
  visibility: 'internal',
  description:
    '[internal] Run YAGNI headless and stream progress + result over IPC (forked by the live view)',
  commonFlags: ['cwd'],
  options: [
    {
      flag: '--config',
      value: '<path>',
      description: 'Resolved project config inherited from the parent run',
    },
  ],
  args: [{ name: 'specPath', description: 'Path to a JSON YAGNI run spec file' }],
  scope: 'project',
  output: 'raw-stream',
  rawStreamReason: 'worker-ipc',
  handler: async (rawOpts, cli): Promise<void> => {
    const specPath = (rawOpts as { _args?: readonly string[] })._args?.[0] ?? '';
    await executeYagniWorker(specPath, cli);
  },
});
