import {
  AUTHORED_REPLAY_MANIFEST_KIND,
  AUTHORED_REPLAY_MANIFEST_VERSION,
  INIT_AUTHORED_PLAN_CAPS,
  absentPathState,
  authoredPlanFailure,
  caseFoldPath,
  compareUtf8,
  normalizeLanguages,
  normalizeProjectRelativePath,
  validateMode,
  validateToolIdentity,
} from './init-authored-plan-types.js';

import type {
  AuthoredReplayManifest,
  InitAuthoredMutation,
  InitAuthoredMutationAction,
  InitAuthoredNormalizedInputs,
  InitAuthoredPathState,
} from './init-authored-plan-types.js';
import type { ToolScaffoldIdentity } from '../shared.js';

const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const ACTIONS = ['create', 'replace', 'delete', 'preserve'] as const;
const TARGET_TYPES = ['file', 'directory'] as const;

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    authoredPlanFailure(`${field} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    authoredPlanFailure(`${field} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    authoredPlanFailure(`${field} has unknown or missing fields`);
  }
}

function integer(value: unknown, field: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    authoredPlanFailure(`${field} must be an integer from 0 through ${String(maximum)}`);
  }
  return value;
}

function choice<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    authoredPlanFailure(`${field} is unsupported`);
  }
  return value as T;
}

function nullableChoice<T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
): T | null {
  return value === null ? null : choice(value, values, field);
}

function digest(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    authoredPlanFailure(`${field} must be a lowercase SHA-256 digest or null`);
  }
  return value;
}

function parseState(value: unknown, field: string): InitAuthoredPathState {
  const object = plainObject(value, field);
  exactKeys(object, ['exists', 'type', 'mode', 'digest'], field);
  if (typeof object.exists !== 'boolean') authoredPlanFailure(`${field}.exists must be boolean`);
  const type = nullableChoice(object.type, TARGET_TYPES, `${field}.type`);
  const mode = object.mode === null ? null : integer(object.mode, `${field}.mode`, 0o777);
  const hash = digest(object.digest, `${field}.digest`);
  if (!object.exists) {
    if (type !== null || mode !== null || hash !== null) {
      authoredPlanFailure(`${field} absent state must have null identity`);
    }
    return absentPathState();
  }
  if (type === null || mode === null || hash === null) {
    authoredPlanFailure(`${field} existing state requires type, mode, and digest`);
  }
  if ((mode & 0o022) !== 0) authoredPlanFailure(`${field}.mode is group/world writable`);
  return { exists: true, type, mode, digest: hash };
}

function sameState(left: InitAuthoredPathState, right: InitAuthoredPathState): boolean {
  return (
    left.exists === right.exists &&
    left.type === right.type &&
    left.mode === right.mode &&
    left.digest === right.digest
  );
}

function expectedAction(
  preimage: InitAuthoredPathState,
  desired: InitAuthoredPathState,
): InitAuthoredMutationAction {
  if (!preimage.exists && desired.exists) return 'create';
  if (preimage.exists && !desired.exists) return 'delete';
  if (preimage.exists && desired.exists && sameState(preimage, desired)) return 'preserve';
  if (preimage.exists && desired.exists) return 'replace';
  authoredPlanFailure('a mutation cannot preserve two absent states');
}

function expectedBlobName(kind: 'desired' | 'preimage', sequence: number): string {
  return `${kind}/${String(sequence).padStart(4, '0')}.blob`;
}

function parseBlobName(
  value: unknown,
  kind: 'desired' | 'preimage',
  sequence: number,
  state: InitAuthoredPathState,
): string | null {
  if (!state.exists || state.type === 'directory') {
    if (value !== null) authoredPlanFailure(`${kind} directory/absent blob must be null`);
    return null;
  }
  const expected = expectedBlobName(kind, sequence);
  if (
    value !== expected ||
    Buffer.byteLength(expected, 'utf8') > INIT_AUTHORED_PLAN_CAPS.maxBlobNameBytes
  ) {
    authoredPlanFailure(`${kind} blob name is not the canonical host-generated name`);
  }
  return expected;
}

function parseMutation(value: unknown, index: number): InitAuthoredMutation {
  const field = `mutations[${String(index)}]`;
  const object = plainObject(value, field);
  exactKeys(
    object,
    [
      'sequence',
      'action',
      'path',
      'targetType',
      'targetMode',
      'preimage',
      'desired',
      'desiredBlob',
      'preimageBlob',
    ],
    field,
  );
  const sequence = integer(
    object.sequence,
    `${field}.sequence`,
    INIT_AUTHORED_PLAN_CAPS.maxMutations,
  );
  if (sequence !== index) authoredPlanFailure(`${field}.sequence is noncanonical`);
  const action = choice(object.action, ACTIONS, `${field}.action`);
  if (typeof object.path !== 'string') authoredPlanFailure(`${field}.path must be a string`);
  const path = normalizeProjectRelativePath(object.path);
  const targetType = choice(object.targetType, TARGET_TYPES, `${field}.targetType`);
  const targetMode = integer(object.targetMode, `${field}.targetMode`, 0o777);
  if ((targetMode & 0o022) !== 0) authoredPlanFailure(`${field}.targetMode is unsafe`);
  const preimage = parseState(object.preimage, `${field}.preimage`);
  const desired = parseState(object.desired, `${field}.desired`);
  const expectedTarget = desired.exists ? desired : preimage;
  if (
    !expectedTarget.exists ||
    targetType !== expectedTarget.type ||
    targetMode !== expectedTarget.mode
  ) {
    authoredPlanFailure(`${field} target identity disagrees with its states`);
  }
  if (action !== expectedAction(preimage, desired)) {
    authoredPlanFailure(`${field}.action disagrees with its states`);
  }
  return {
    sequence,
    action,
    path,
    targetType,
    targetMode,
    preimage,
    desired,
    desiredBlob: parseBlobName(object.desiredBlob, 'desired', sequence, desired),
    preimageBlob: parseBlobName(object.preimageBlob, 'preimage', sequence, preimage),
  };
}

function parseIdentity(value: unknown, index: number): ToolScaffoldIdentity {
  const field = `inputs.tools[${String(index)}]`;
  const object = plainObject(value, field);
  exactKeys(object, ['stableId', 'name', 'version'], field);
  if (
    typeof object.stableId !== 'string' ||
    typeof object.name !== 'string' ||
    typeof object.version !== 'string'
  ) {
    authoredPlanFailure(`${field} values must be strings`);
  }
  const identity = {
    stableId: object.stableId,
    name: object.name,
    version: object.version,
  };
  validateToolIdentity(identity, field);
  return identity;
}

function parseInputs(value: unknown): InitAuthoredNormalizedInputs {
  const object = plainObject(value, 'inputs');
  exactKeys(object, ['languages', 'mode', 'tools'], 'inputs');
  if (typeof object.mode !== 'string') authoredPlanFailure('inputs.mode must be a string');
  validateMode(object.mode);
  if (!Array.isArray(object.languages)) authoredPlanFailure('inputs.languages must be an array');
  const languages = object.languages.map((language, index) => {
    if (typeof language !== 'string') {
      authoredPlanFailure(`inputs.languages[${String(index)}] must be a string`);
    }
    return language;
  });
  const normalizedLanguages = normalizeLanguages(
    languages as InitAuthoredNormalizedInputs['languages'],
    { allowEmpty: object.mode === 'refresh' },
  );
  if (
    normalizedLanguages.length !== languages.length ||
    normalizedLanguages.some((language, index) => language !== languages[index])
  ) {
    authoredPlanFailure('inputs.languages must be in canonical order');
  }
  if (!Array.isArray(object.tools)) authoredPlanFailure('inputs.tools must be an array');
  const tools = object.tools.map(parseIdentity);
  const stableIds = new Set(tools.map((tool) => tool.stableId));
  const names = new Set(tools.map((tool) => tool.name));
  if (stableIds.size !== tools.length || names.size !== tools.length) {
    authoredPlanFailure('inputs.tools identities must be unique');
  }
  return { languages: normalizedLanguages, mode: object.mode, tools };
}

function parseManifest(value: unknown): AuthoredReplayManifest {
  const object = plainObject(value, 'manifest');
  exactKeys(object, ['kind', 'version', 'inputs', 'mutations'], 'manifest');
  if (object.kind !== AUTHORED_REPLAY_MANIFEST_KIND) {
    authoredPlanFailure('manifest.kind is unsupported');
  }
  if (object.version !== AUTHORED_REPLAY_MANIFEST_VERSION) {
    authoredPlanFailure('manifest.version is unsupported');
  }
  const inputs = parseInputs(object.inputs);
  if (!Array.isArray(object.mutations)) authoredPlanFailure('manifest.mutations must be an array');
  if (object.mutations.length > INIT_AUTHORED_PLAN_CAPS.maxMutations) {
    authoredPlanFailure(`mutation count exceeds ${String(INIT_AUTHORED_PLAN_CAPS.maxMutations)}`);
  }
  const mutations = object.mutations.map(parseMutation);
  const folded = new Set<string>();
  for (let index = 0; index < mutations.length; index += 1) {
    const mutation = mutations[index];
    if (index > 0 && compareUtf8(mutations[index - 1].path, mutation.path) >= 0) {
      authoredPlanFailure('manifest mutations are not in canonical UTF-8 path order');
    }
    const caseFolded = caseFoldPath(mutation.path);
    if (folded.has(caseFolded)) authoredPlanFailure('manifest paths collide under case folding');
    folded.add(caseFolded);
  }
  return {
    kind: AUTHORED_REPLAY_MANIFEST_KIND,
    version: AUTHORED_REPLAY_MANIFEST_VERSION,
    inputs,
    mutations,
  };
}

/** Compact canonical JSON with no trailing newline. */
export function encodeAuthoredReplayManifest(manifest: AuthoredReplayManifest): string {
  const canonical = parseManifest(manifest);
  const bytes = JSON.stringify(canonical);
  if (Buffer.byteLength(bytes, 'utf8') > INIT_AUTHORED_PLAN_CAPS.maxManifestBytes) {
    authoredPlanFailure(
      `replay manifest exceeds ${String(INIT_AUTHORED_PLAN_CAPS.maxManifestBytes)} bytes`,
    );
  }
  return bytes;
}

/** Parse only canonical v1 bytes; whitespace, reordered keys, and unknown fields fail closed. */
export function parseAuthoredReplayManifest(raw: string): AuthoredReplayManifest {
  if (Buffer.byteLength(raw, 'utf8') > INIT_AUTHORED_PLAN_CAPS.maxManifestBytes) {
    authoredPlanFailure(
      `replay manifest exceeds ${String(INIT_AUTHORED_PLAN_CAPS.maxManifestBytes)} bytes`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    authoredPlanFailure('replay manifest is not valid JSON');
  }
  const canonical = parseManifest(parsed);
  if (raw !== encodeAuthoredReplayManifest(canonical)) {
    authoredPlanFailure('replay manifest is not canonical v1 JSON');
  }
  return canonical;
}
