/**
 * Durable, callback-free Init authored replay planning.
 *
 * `createInitAuthoredPlan` is the read-only composition seam: it evaluates each
 * Tool renderer once, snapshots bounded preimages without following links, and
 * delegates to the pure `buildInitAuthoredPlan`. No function in this module
 * creates, removes, renames, checkpoints, or writes a customer path.
 */

import { enumerateToolScaffolds } from "../shared.js";

import {
  buildInitAuthoredPlan,
  collectInitAuthoredTargetPaths,
} from "./init-authored-plan-builder.js";
import { readInitAuthoredSnapshot } from "./init-authored-plan-snapshot.js";
import { normalizeLanguages } from "./init-authored-plan-types.js";

import type {
  CreateInitAuthoredPlanInput,
  InitAuthoredPlan,
  RenderedInitToolScaffold,
} from "./init-authored-plan-types.js";

export {
  encodeAuthoredReplayManifest,
  parseAuthoredReplayManifest,
} from "./init-authored-plan-manifest.js";

export { readInitAuthoredSnapshot } from "./init-authored-plan-snapshot.js";
export {
  AUTHORED_REPLAY_MANIFEST_KIND,
  AUTHORED_REPLAY_MANIFEST_VERSION,
  INIT_AUTHORED_PLAN_CAPS,
} from "./init-authored-plan-types.js";
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
  ReadInitAuthoredSnapshotInput,
  RenderedInitToolScaffold,
} from "./init-authored-plan-types.js";

export function createInitAuthoredPlan(
  input: CreateInitAuthoredPlanInput,
): InitAuthoredPlan {
  const languages = normalizeLanguages(input.languages);
  const rendered = enumerateToolScaffolds(input.toolScaffolds, { languages });
  const toolScaffolds: readonly RenderedInitToolScaffold[] = rendered.map(
    (scaffold, index) => ({
      ...scaffold,
      createsExampleDirectories:
        input.toolScaffolds[index]?.scaffoldExamples !== undefined,
    }),
  );
  const targetPaths = collectInitAuthoredTargetPaths(input.mode, toolScaffolds);
  const snapshot = readInitAuthoredSnapshot({
    projectRoot: input.projectRoot,
    targetPaths,
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
  });
  return buildInitAuthoredPlan({
    languages,
    mode: input.mode,
    toolScaffolds,
    snapshot,
  });
}

/** Decode an immutable in-memory blob for Task 3.4 materialization. */
export function decodeInitAuthoredPlanBlob(
  plan: InitAuthoredPlan,
  kind: "desired" | "preimage",
  name: string,
): Buffer {
  const encoded = plan.blobs[kind][name];
  if (encoded === undefined)
    throw new Error(`Unknown Init authored ${kind} blob: ${name}`);
  return Buffer.from(encoded, "base64");
}

export {
  buildInitAuthoredPlan,
  collectInitAuthoredTargetPaths,
} from "./init-authored-plan-builder.js";
