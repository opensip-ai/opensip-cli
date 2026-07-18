/**
 * Durable, callback-free Init authored replay planning.
 *
 * `createInitAuthoredPlan` is the read-only composition seam: it evaluates each
 * Tool renderer once, snapshots bounded preimages without following links, and
 * delegates to the pure `buildInitAuthoredPlan`. No function in this module
 * creates, removes, renames, checkpoints, or writes a customer path.
 */

import { join } from 'node:path';

import { resolveProjectPaths } from '@opensip-cli/core';

import { enumerateToolScaffolds } from '../shared.js';

import { renderAgentGuidanceTargets } from './agent-guidance.js';
import { classifySnapshotFilesFromRenderedScaffolds } from './file-classifier.js';
import {
  buildInitAuthoredPlan,
  collectInitAuthoredTargetPaths,
} from './init-authored-plan-builder.js';
import {
  buildGuidanceSnapshots,
  validateAuthoredSnapshot,
} from './init-authored-plan-snapshot-validation.js';
import { readInitAuthoredSnapshot } from './init-authored-plan-snapshot.js';
import { normalizeLanguages } from './init-authored-plan-types.js';

import type {
  CreateInitAuthoredPlanInput,
  InitAuthoredPlan,
  RenderedInitToolScaffold,
} from './init-authored-plan-types.js';

export {
  encodeAuthoredReplayManifest,
  parseAuthoredReplayManifest,
} from './init-authored-plan-manifest.js';

export { readInitAuthoredSnapshot } from './init-authored-plan-snapshot.js';
export {
  AUTHORED_REPLAY_MANIFEST_KIND,
  AUTHORED_REPLAY_MANIFEST_VERSION,
  INIT_AUTHORED_PLAN_CAPS,
} from './init-authored-plan-types.js';
export type {
  AuthoredReplayManifest,
  BuildInitAuthoredPlanInput,
  CreateInitAuthoredPlanInput,
  InitAuthoredMode,
  InitAuthoredMutation,
  InitAuthoredMutationAction,
  InitAuthoredNormalizedInputs,
  InitAuthoredPathState,
  InitAuthoredPlan,
  InitAuthoredPlanBlobs,
  InitAuthoredSnapshot,
  InitAuthoredSnapshotHooks,
  InitAuthoredSnapshotRecord,
  InitAuthoredTargetType,
  InitAuthoredWorkingDirState,
  ReadInitAuthoredSnapshotInput,
  RenderedInitToolScaffold,
} from './init-authored-plan-types.js';

export function createInitAuthoredPlan(input: CreateInitAuthoredPlanInput): InitAuthoredPlan {
  const languages = normalizeLanguages(input.languages, {
    allowEmpty: input.mode === 'refresh',
  });
  const rendered =
    input.mode === 'refresh' && languages.length === 0
      ? input.toolScaffolds.map((scaffold) => ({
          identity: { ...scaffold.identity },
          layout: {
            domain: scaffold.layout.domain,
            userSubdirs: [...scaffold.layout.userSubdirs],
          },
          examples: [],
          stableExampleIds: [],
        }))
      : enumerateToolScaffolds(input.toolScaffolds, { languages });
  const toolScaffolds: readonly RenderedInitToolScaffold[] = rendered.map((scaffold, index) => ({
    ...scaffold,
    createsExampleDirectories: input.toolScaffolds[index]?.scaffoldExamples !== undefined,
  }));
  const targetPaths = collectInitAuthoredTargetPaths(input.mode, toolScaffolds);
  const snapshot = readInitAuthoredSnapshot({
    projectRoot: input.projectRoot,
    targetPaths,
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
  });
  const plan = buildInitAuthoredPlan({
    languages,
    mode: input.mode,
    toolScaffolds,
    snapshot,
  });
  const preimages = validateAuthoredSnapshot(snapshot.records);
  const renderedGuidance = renderAgentGuidanceTargets(buildGuidanceSnapshots(preimages), {
    toolScaffolds,
  });
  const projectPaths = resolveProjectPaths(input.projectRoot);
  const preExistingFiles = Object.freeze(
    (languages.length === 0
      ? []
      : classifySnapshotFilesFromRenderedScaffolds(
          projectPaths,
          languages,
          toolScaffolds,
          preimages,
        )
    ).map((file) => Object.freeze({ ...file })),
  );
  const guidanceTargets = Object.freeze(
    renderedGuidance.targets.map((target) =>
      Object.freeze({
        path: join(input.projectRoot, target.relativePath),
        action: target.action,
        ...(target.reason === undefined ? {} : { reason: target.reason }),
      }),
    ),
  );
  const agentGuidance = Object.freeze({
    changed: renderedGuidance.changed,
    targets: guidanceTargets,
  });
  const presentation = Object.freeze({
    preExistingFiles,
    agentGuidance,
    workingDirState: snapshot.workingDirState,
  });
  return Object.freeze({
    ...plan,
    presentation,
  });
}

/** Decode an immutable in-memory blob for Task 3.4 materialization. */
export function decodeInitAuthoredPlanBlob(
  plan: InitAuthoredPlan,
  kind: 'desired' | 'preimage',
  name: string,
): Buffer {
  const encoded = plan.blobs[kind][name];
  if (encoded === undefined) throw new Error(`Unknown Init authored ${kind} blob: ${name}`);
  return Buffer.from(encoded, 'base64');
}

export {
  buildInitAuthoredPlan,
  collectInitAuthoredTargetPaths,
} from './init-authored-plan-builder.js';
