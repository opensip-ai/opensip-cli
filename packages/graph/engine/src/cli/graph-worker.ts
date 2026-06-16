// @fitness-ignore-file detached-promises -- this worker's `send()` helper is synchronous (it calls process.send, which returns immediately); the name-based heuristic mistakes the floating send(...) IPC posts for promise-returning calls. The one genuine async call (runGraph) is awaited.
/**
 * `graph-run-worker <specPath>` — the headless graph build forked by the live
 * view (ADR-0028). The live runner forks `node <cliScript> graph-run-worker
 * <spec>`; because it runs through the full CLI bootstrap, the language-adapter
 * registry, project, and config are populated in scope exactly as a normal
 * `graph` run — so the build (the heavy TS type-check / parse / walk / resolve)
 * runs OFF the parent's render thread while the parent stays free to animate the
 * stage checklist + 80ms clock.
 *
 * The spec carries only serializable inputs (cwd, resolution, noCache, recipe
 * NAME, and optionally the already-planned shard set). The worker re-loads the
 * graph config and re-resolves the recipe → rules itself (rules are functions —
 * they can't cross the boundary), mirroring `executeGraph`'s setup. It streams
 * stage progress over IPC and posts the final {@link LiveGraphOutput} — the slim,
 * serializable `{ signals, reportLines }` payload (a raw `RunGraphResult` can't
 * cross the fork boundary: it carries class-method accumulators + Maps). The
 * parent persists the signals + renders the report lines; the worker does all
 * the heavy build + report assembly. Internal command — the live runner is its
 * only caller.
 */

import { readFileSync } from 'node:fs';

import {
  defineCommand,
  type CommandSpec,
  type ToolCliContext,
  type WorkerMessage,
} from '@opensip-cli/core';

import { resolveRecipeToRules } from '../recipes/resolve.js';

import { toProgressEvent } from './graph-progress.js';
import { buildLiveGraphOutput, runShardedLiveBuild, type LiveGraphOutput } from './graph.js';
import { loadGraphConfig, resolveGraphRecipeSelection, runGraph } from './orchestrate.js';

import type { Shard } from './orchestrate/shard-model.js';
import type { ProgressEvent } from '@opensip-cli/cli-ui';
import type { DataStore } from '@opensip-cli/datastore';

interface GraphWorkerSpec {
  readonly cwd: string;
  readonly noCache?: boolean;
  readonly resolution?: 'exact' | 'fast';
  readonly recipe?: string;
  readonly exact?: boolean;
  readonly shards?: readonly Shard[];
}

/** Post one IPC message to the parent (no-op when not forked). */
function send(msg: WorkerMessage<ProgressEvent, LiveGraphOutput>): void {
  process.send?.(msg);
}

/**
 * Read the build spec, re-derive config + rules, run `runGraph` headless, and
 * stream stage progress + the final result over IPC. Never throws to the caller —
 * a failure is sent as a `{ kind: 'error' }` message so the parent rejects cleanly.
 */
export async function executeGraphWorker(specPath: string, cli: ToolCliContext): Promise<void> {
  try {
    const args = JSON.parse(readFileSync(specPath, 'utf8')) as GraphWorkerSpec;
    const config = loadGraphConfig(args.cwd);
    const recipeSelection = resolveGraphRecipeSelection(args.cwd, args.recipe);
    const rules = resolveRecipeToRules(recipeSelection.name, {
      tolerant: recipeSelection.tolerant,
    });
    const datastore = cli.scope.datastore() as DataStore | undefined;
    const sharded = (args.shards?.length ?? 0) > 1;
    if (sharded) {
      send({
        kind: 'result',
        value: await runShardedLiveBuild(
          {
            cwd: args.cwd,
            noCache: args.noCache,
            resolution: args.resolution,
            exact: args.exact,
            config,
            rules,
            cliScript: process.argv[1],
          },
          args.shards ?? [],
          datastore,
          (event) => send({ kind: 'progress', event: toProgressEvent(event, true) }),
        ),
      });
      return;
    }
    const result = await runGraph({
      cwd: args.cwd,
      noCache: args.noCache,
      resolution: args.resolution,
      config,
      rules,
      datastore,
      onProgress: (event) => send({ kind: 'progress', event: toProgressEvent(event) }),
    });
    // Send only the serializable slim payload — a RunGraphResult can't cross the
    // fork boundary (class-method accumulators + Maps). The parent persists the
    // signals + renders from reportLines (ADR-0028).
    //
    // Suppression runs HERE, inside the worker (ADR-0014): buildLiveGraphOutput
    // is the single chokepoint, and the worker holds the build root (args.cwd)
    // plus disk access to read the `@graph-ignore`-directive files. The parent
    // receives an already-waived LiveGraphOutput — it re-stamps the FinalizedSignals
    // brand the IPC structured-clone drops, but performs NO second suppression.
    send({
      kind: 'result',
      value: await buildLiveGraphOutput(result, args.cwd),
    });
  } catch (error) {
    send({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    });
  }
}

/** `graph-run-worker` — [internal] headless graph build, IPC progress/result. */
export const graphRunWorkerCommandSpec: CommandSpec<unknown, ToolCliContext> = defineCommand<
  unknown,
  ToolCliContext
>({
  name: 'graph-run-worker',
  description:
    '[internal] Run the graph build headless and stream progress + result over IPC (forked by the live view)',
  commonFlags: [],
  args: [{ name: 'specPath', description: 'Path to a JSON graph build-spec file' }],
  scope: 'project',
  output: 'raw-stream',
  rawStreamReason: 'worker-ipc',
  handler: async (rawOpts, cli): Promise<void> => {
    const specPath = (rawOpts as { _args?: readonly string[] })._args?.[0] ?? '';
    await executeGraphWorker(specPath, cli);
  },
});
