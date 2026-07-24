import { renderAgentGuidanceTargets } from './agent-guidance.js';
import { generateConfigFromRenderedScaffolds } from './config-templates.js';
import {
  caseFoldPath,
  compareUtf8,
  normalizeLanguages,
  normalizeProjectRelativePath,
  normalizeToolIdentities,
  sha256Bytes,
  sha256Parts,
} from './init-authored-plan-hashing.js';
import { encodeAuthoredReplayManifest } from './init-authored-plan-manifest.js';
import {
  buildGuidanceSnapshots,
  decodeSnapshotUtf8,
  validateAuthoredSnapshot,
} from './init-authored-plan-snapshot-validation.js';
import { collectToolDesiredEntries } from './init-authored-plan-targets.js';
// Manifest/caps protocol constants + the plan-failure helper.
import {
  AUTHORED_REPLAY_MANIFEST_KIND,
  AUTHORED_REPLAY_MANIFEST_VERSION,
  INIT_AUTHORED_OPAQUE_DIRECTORY_NAMES,
  INIT_AUTHORED_PLAN_CAPS,
  authoredPlanFailure,
  // Authored path-state construction/comparison helpers.
  absentPathState,
  directoryDigest,
  sameAuthoredPathState,
  stateFromSnapshot,
} from './init-authored-plan-types.js';
// Hashing + value-normalization helpers (re-exported via a companion module so
// this consumer stays under the heavy-import threshold without duplicate imports).
import { renderGitignore } from './scaffold-writer.js';

import type { InitAuthoredDesiredTarget } from './init-authored-plan-targets.js';
import type {
  AuthoredReplayManifest,
  BuildInitAuthoredPlanInput,
  InitAuthoredMutation,
  InitAuthoredMutationAction,
  InitAuthoredPathState,
  InitAuthoredPlan,
  InitAuthoredSnapshotRecord,
} from './init-authored-plan-types.js';

export { collectInitAuthoredTargetPaths } from './init-authored-plan-targets.js';

interface DesiredEntry {
  readonly state: InitAuthoredPathState;
  readonly contentBase64: string | null;
}

const FILE_MODE = 0o644;
const DIRECTORY_MODE = 0o755;

function generatedFile(content: string, mode: number): DesiredEntry {
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > INIT_AUTHORED_PLAN_CAPS.maxFileBytes) {
    authoredPlanFailure('generated authored file exceeds the file cap');
  }
  return {
    state: { exists: true, type: 'file', mode, digest: sha256Bytes(bytes) },
    contentBase64: bytes.toString('base64'),
  };
}

function generatedDirectory(mode: number): DesiredEntry {
  return {
    state: {
      exists: true,
      type: 'directory',
      mode,
      digest: directoryDigest(mode),
    },
    contentBase64: null,
  };
}

function mutationAction(
  preimage: InitAuthoredPathState,
  desired: InitAuthoredPathState,
): InitAuthoredMutationAction {
  if (!preimage.exists) return 'create';
  if (!desired.exists) return 'delete';
  return sameAuthoredPathState(preimage, desired) ? 'preserve' : 'replace';
}

function snapshotDesired(record: InitAuthoredSnapshotRecord): DesiredEntry {
  return {
    state: stateFromSnapshot(record),
    contentBase64: record.contentBase64,
  };
}

function renderedToolDesired(
  path: string,
  preimage: InitAuthoredSnapshotRecord,
  entry: InitAuthoredDesiredTarget,
  mode: BuildInitAuthoredPlanInput['mode'],
): DesiredEntry {
  if (mode === 'keep' && preimage.exists) {
    if (preimage.type !== entry.type) {
      authoredPlanFailure(`${path} has a conflicting target type`);
    }
    return snapshotDesired(preimage);
  }
  if (preimage.exists && preimage.type !== entry.type && mode !== 'remove') {
    authoredPlanFailure(`${path} has a conflicting target type`);
  }
  if (entry.type === 'directory') {
    const modeBits =
      preimage.exists && preimage.type === 'directory' && mode !== 'remove'
        ? preimage.mode
        : DIRECTORY_MODE;
    return generatedDirectory(modeBits);
  }
  const modeBits =
    preimage.exists && preimage.type === 'file' && mode !== 'remove' ? preimage.mode : FILE_MODE;
  return generatedFile(entry.content ?? '', modeBits);
}

function setToolDesired(
  desired: Map<string, DesiredEntry>,
  preimages: ReadonlyMap<string, InitAuthoredSnapshotRecord>,
  entries: ReadonlyMap<string, InitAuthoredDesiredTarget>,
  mode: BuildInitAuthoredPlanInput['mode'],
): void {
  for (const [path, entry] of entries) {
    const preimage = preimages.get(path);
    if (preimage === undefined) {
      authoredPlanFailure(`snapshot is missing Tool target ${path}`);
    }
    desired.set(path, renderedToolDesired(path, preimage, entry, mode));
  }
}

function buildDesiredEntries(
  input: BuildInitAuthoredPlanInput,
  preimages: ReadonlyMap<string, InitAuthoredSnapshotRecord>,
  opaquePaths: readonly string[],
): Map<string, DesiredEntry> {
  const desired = new Map<string, DesiredEntry>();
  seedExistingAuthored(desired, preimages, input.mode, opaquePaths);
  if (input.mode !== 'refresh') {
    setToolDesired(desired, preimages, collectToolDesiredEntries(input.toolScaffolds), input.mode);
  }
  setConfigDesired(desired, preimages, input);
  setGitignoreDesired(desired, preimages);
  setGuidanceDesired(desired, preimages, input);
  return desired;
}

function seedExistingAuthored(
  desired: Map<string, DesiredEntry>,
  preimages: ReadonlyMap<string, InitAuthoredSnapshotRecord>,
  mode: BuildInitAuthoredPlanInput['mode'],
  opaquePaths: readonly string[],
): void {
  for (const [path, record] of preimages) {
    const isAuthored = path === 'opensip-cli' || path.startsWith('opensip-cli/');
    const preservesOpaqueChild = opaquePaths.some((opaque) => opaque.startsWith(`${path}/`));
    if (isAuthored && (mode !== 'remove' || path === 'opensip-cli' || preservesOpaqueChild)) {
      desired.set(path, snapshotDesired(record));
    }
  }
}

function validateOpaquePaths(
  paths: readonly string[],
  preimages: ReadonlyMap<string, InitAuthoredSnapshotRecord>,
): readonly string[] {
  const normalized = paths.map(normalizeProjectRelativePath).sort(compareUtf8);
  const folded = new Set<string>();
  for (const [index, path] of normalized.entries()) {
    if (path !== paths[index] || path === normalized[index - 1]) {
      authoredPlanFailure('opaque snapshot paths must be unique and in canonical order');
    }
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (
      !path.startsWith('opensip-cli/') ||
      !(INIT_AUTHORED_OPAQUE_DIRECTORY_NAMES as readonly string[]).includes(name)
    ) {
      authoredPlanFailure(`unsupported opaque snapshot path ${path}`);
    }
    const foldedPath = caseFoldPath(path);
    if (folded.has(foldedPath)) {
      authoredPlanFailure(`case-folded opaque snapshot collision at ${path}`);
    }
    folded.add(foldedPath);
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      const ancestor = segments.slice(0, depth).join('/');
      const record = preimages.get(ancestor);
      if (record?.exists !== true || record.type !== 'directory') {
        authoredPlanFailure(`opaque snapshot path ${path} lacks directory ancestor ${ancestor}`);
      }
    }
  }
  return normalized;
}

function assertNoOpaqueTargetConflict(
  opaquePaths: readonly string[],
  desired: ReadonlyMap<string, DesiredEntry>,
): void {
  for (const opaque of opaquePaths) {
    for (const target of desired.keys()) {
      if (target === opaque || target.startsWith(`${opaque}/`)) {
        authoredPlanFailure(`Init target ${target} conflicts with preserved opaque path ${opaque}`);
      }
    }
  }
}

function setConfigDesired(
  desired: Map<string, DesiredEntry>,
  preimages: ReadonlyMap<string, InitAuthoredSnapshotRecord>,
  input: BuildInitAuthoredPlanInput,
): void {
  const config = preimages.get('opensip-cli.config.yml');
  if (config === undefined) {
    authoredPlanFailure('snapshot is missing opensip-cli.config.yml');
  }
  if (
    input.mode === 'fresh' ||
    input.mode === 'remove' ||
    (input.mode === 'keep' && !config.exists)
  ) {
    if (config.exists && config.type !== 'file') {
      authoredPlanFailure('opensip-cli.config.yml must be a file');
    }
    desired.set(
      'opensip-cli.config.yml',
      generatedFile(
        generateConfigFromRenderedScaffolds(input.languages, input.toolScaffolds),
        config.exists ? config.mode : FILE_MODE,
      ),
    );
  } else if (config.exists) {
    desired.set('opensip-cli.config.yml', snapshotDesired(config));
  }
}

function setGitignoreDesired(
  desired: Map<string, DesiredEntry>,
  preimages: ReadonlyMap<string, InitAuthoredSnapshotRecord>,
): void {
  const gitignore = preimages.get('.gitignore');
  if (gitignore === undefined) {
    authoredPlanFailure('snapshot is missing .gitignore');
  }
  if (gitignore.exists && gitignore.type !== 'file') {
    authoredPlanFailure('.gitignore must be a file');
  }
  const renderedGitignore = renderGitignore(
    gitignore.exists ? decodeSnapshotUtf8(gitignore, '.gitignore') : undefined,
  );
  desired.set(
    '.gitignore',
    generatedFile(renderedGitignore.content, gitignore.exists ? gitignore.mode : FILE_MODE),
  );
}

function setGuidanceDesired(
  desired: Map<string, DesiredEntry>,
  preimages: ReadonlyMap<string, InitAuthoredSnapshotRecord>,
  input: BuildInitAuthoredPlanInput,
): void {
  const renderedGuidance = renderAgentGuidanceTargets(buildGuidanceSnapshots(preimages), {
    toolScaffolds: input.toolScaffolds,
  });
  for (const target of renderedGuidance.targets) {
    if (target.content === undefined) continue;
    const preimage = preimages.get(target.relativePath);
    if (preimage === undefined) {
      authoredPlanFailure(`snapshot is missing ${target.relativePath}`);
    }
    desired.set(
      target.relativePath,
      // An unmanaged preimage never reaches here (unreadable targets carry no
      // content), so the null-mode arm safely falls back to the default.
      generatedFile(
        target.content,
        preimage.exists && preimage.mode !== null ? preimage.mode : FILE_MODE,
      ),
    );
  }
}

function freezeMutation(mutation: InitAuthoredMutation): InitAuthoredMutation {
  return Object.freeze({
    ...mutation,
    preimage: Object.freeze({ ...mutation.preimage }),
    desired: Object.freeze({ ...mutation.desired }),
  });
}

export function buildInitAuthoredPlan(input: BuildInitAuthoredPlanInput): InitAuthoredPlan {
  const languages = normalizeLanguages(input.languages, {
    allowEmpty: input.mode === 'refresh',
  });
  const tools = normalizeToolIdentities(input.toolScaffolds);
  const preimages = validateAuthoredSnapshot(input.snapshot.records);
  const opaquePaths = validateOpaquePaths(input.snapshot.opaquePaths, preimages);
  const desired = buildDesiredEntries({ ...input, languages }, preimages, opaquePaths);
  assertNoOpaqueTargetConflict(opaquePaths, desired);
  const paths = new Set<string>(desired.keys());
  for (const path of preimages.keys()) {
    if (path === 'opensip-cli' || path.startsWith('opensip-cli/')) paths.add(path);
  }

  const orderedPaths = [...paths].sort(compareUtf8);
  if (orderedPaths.length > INIT_AUTHORED_PLAN_CAPS.maxMutations) {
    authoredPlanFailure(`mutation count exceeds ${String(INIT_AUTHORED_PLAN_CAPS.maxMutations)}`);
  }
  const desiredBlobs: Record<string, string> = {};
  const preimageBlobs: Record<string, string> = {};
  let aggregateBlobBytes = 0;
  const mutations = orderedPaths.map((path, sequence) => {
    const preimageRecord = preimages.get(path);
    const desiredEntry = desired.get(path);
    const preimage =
      preimageRecord === undefined ? absentPathState() : stateFromSnapshot(preimageRecord);
    const desiredState = desiredEntry?.state ?? absentPathState();
    if (!preimage.exists && !desiredState.exists) authoredPlanFailure(`${path} has no plan effect`);
    const target = desiredState.exists ? desiredState : preimage;
    if (!target.exists || target.type === null || target.mode === null) {
      authoredPlanFailure(`${path} has no target identity`);
    }
    const desiredBlob =
      desiredState.exists && desiredState.type === 'file'
        ? `desired/${String(sequence).padStart(4, '0')}.blob`
        : null;
    const preimageBlob =
      preimage.exists && preimage.type === 'file'
        ? `preimage/${String(sequence).padStart(4, '0')}.blob`
        : null;
    if (desiredBlob !== null) {
      if (desiredEntry?.contentBase64 === null || desiredEntry?.contentBase64 === undefined) {
        authoredPlanFailure(`${path} is missing desired bytes`);
      }
      desiredBlobs[desiredBlob] = desiredEntry.contentBase64;
      aggregateBlobBytes += Buffer.from(desiredEntry.contentBase64, 'base64').length;
    }
    if (preimageBlob !== null) {
      if (preimageRecord?.contentBase64 === null || preimageRecord?.contentBase64 === undefined) {
        authoredPlanFailure(`${path} is missing preimage bytes`);
      }
      preimageBlobs[preimageBlob] = preimageRecord.contentBase64;
      aggregateBlobBytes += Buffer.from(preimageRecord.contentBase64, 'base64').length;
    }
    return freezeMutation({
      sequence,
      action: mutationAction(preimage, desiredState),
      path,
      targetType: target.type,
      targetMode: target.mode,
      preimage,
      desired: desiredState,
      desiredBlob,
      preimageBlob,
    });
  });
  if (aggregateBlobBytes > INIT_AUTHORED_PLAN_CAPS.maxAggregateBlobBytes) {
    authoredPlanFailure('planned blobs exceed the aggregate content cap');
  }
  const inputs = Object.freeze({
    languages: Object.freeze([...languages]),
    mode: input.mode,
    tools: Object.freeze(tools.map((tool) => Object.freeze({ ...tool }))),
  });
  const replayManifest: AuthoredReplayManifest = Object.freeze({
    kind: AUTHORED_REPLAY_MANIFEST_KIND,
    version: AUTHORED_REPLAY_MANIFEST_VERSION,
    inputs,
    mutations: Object.freeze(mutations),
  });
  const replayManifestBytes = encodeAuthoredReplayManifest(replayManifest);
  const normalizedInputBytes = JSON.stringify(inputs);
  const digest = sha256Parts([
    'opensip-init-authored-plan\0v1\0',
    normalizedInputBytes,
    '\0',
    replayManifestBytes,
  ]);
  return Object.freeze({
    inputs,
    mutations: replayManifest.mutations,
    replayManifest,
    replayManifestBytes,
    replayManifestDigest: sha256Bytes(replayManifestBytes),
    digest,
    aggregateBlobBytes,
    blobs: Object.freeze({
      desired: Object.freeze(desiredBlobs),
      preimage: Object.freeze(preimageBlobs),
    }),
  });
}
