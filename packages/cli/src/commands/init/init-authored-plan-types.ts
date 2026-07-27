import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import { ConfigurationError } from '@opensip-cli/core';

import { hostErrorCatalog } from '../../errors/host-error-catalog.js';

import {
  RUNTIME_PROMOTION_AUTHORED_MODES,
  RUNTIME_PROMOTION_JOURNAL_CAPS,
  RUNTIME_PROMOTION_LANGUAGES,
} from './runtime-promotion-journal-types.js';

import type { RenderedToolScaffold, ToolScaffold, ToolScaffoldIdentity } from '../shared.js';
import type {
  RuntimePromotionAuthoredMode,
  RuntimePromotionLanguage,
} from './runtime-promotion-journal-types.js';
import type { AgentGuidanceResult, PreExistingFile } from '@opensip-cli/contracts';

// Plan 01 clean break: registered host definitions replace bare code literals that only
// resolved through legacyFamilyCode's head-guessing.
const OPTION_INVALID = hostErrorCatalog.require('CLI.HOST.OPTION_INVALID');

export const AUTHORED_REPLAY_MANIFEST_KIND = 'opensip-init-authored-replay' as const;
export const AUTHORED_REPLAY_MANIFEST_VERSION = 1 as const;
export const INIT_AUTHORED_OPAQUE_DIRECTORY_NAMES = Object.freeze([
  'node_modules',
  'dist',
  'coverage',
  '.turbo',
] as const);

export const INIT_AUTHORED_PLAN_CAPS = Object.freeze({
  maxMutations: RUNTIME_PROMOTION_JOURNAL_CAPS.maxAuthoredMutations,
  maxManifestBytes: 4 * 1024 * 1024,
  maxPathBytes: 4096,
  maxBlobNameBytes: 128,
  maxFileBytes: 16 * 1024 * 1024,
  maxAggregateBlobBytes: 256 * 1024 * 1024,
  maxTraversalEntries: RUNTIME_PROMOTION_JOURNAL_CAPS.maxAuthoredMutations,
  maxTraversalDepth: 64,
  maxIdentityBytes: 256,
});

export type InitAuthoredMode = RuntimePromotionAuthoredMode;
export type InitAuthoredWorkingDirState =
  'pristine' | 'fully-initialized' | 'partial-config-only' | 'partial-dir-only';
export type InitAuthoredMutationAction = 'create' | 'replace' | 'delete' | 'preserve';
export type InitAuthoredTargetType = 'file' | 'directory';

export interface InitAuthoredPathState {
  readonly exists: boolean;
  readonly type: InitAuthoredTargetType | null;
  readonly mode: number | null;
  readonly digest: string | null;
}

export interface InitAuthoredMutation {
  readonly sequence: number;
  readonly action: InitAuthoredMutationAction;
  readonly path: string;
  readonly targetType: InitAuthoredTargetType;
  readonly targetMode: number;
  readonly preimage: InitAuthoredPathState;
  readonly desired: InitAuthoredPathState;
  readonly desiredBlob: string | null;
  readonly preimageBlob: string | null;
}

export interface InitAuthoredNormalizedInputs {
  readonly languages: readonly RuntimePromotionLanguage[];
  readonly mode: InitAuthoredMode;
  /** Tool order is intentionally significant for a newly rendered plan. */
  readonly tools: readonly ToolScaffoldIdentity[];
}

export interface AuthoredReplayManifest {
  readonly kind: typeof AUTHORED_REPLAY_MANIFEST_KIND;
  readonly version: typeof AUTHORED_REPLAY_MANIFEST_VERSION;
  readonly inputs: InitAuthoredNormalizedInputs;
  /** Canonical UTF-8 project-relative path order. */
  readonly mutations: readonly InitAuthoredMutation[];
}

export type InitAuthoredSnapshotRecord =
  | {
      readonly path: string;
      readonly exists: false;
      readonly type: null;
      readonly mode: null;
      readonly digest: null;
      readonly contentBase64: null;
    }
  | {
      readonly path: string;
      readonly exists: true;
      readonly type: 'directory';
      readonly mode: number;
      readonly digest: string;
      readonly contentBase64: null;
    }
  | {
      readonly path: string;
      readonly exists: true;
      readonly type: 'file';
      readonly mode: number;
      readonly digest: string;
      readonly contentBase64: string;
    }
  | {
      /**
       * A guidance target that EXISTS but cannot be managed: a symlink (init
       * must never write through a link) or a file beyond the managed
       * guidance cap. Init proceeds; the path gets NO mutation and renders as
       * a skipped guidance target. Only guidance-spec paths may carry this
       * arm — {@link stateFromSnapshot} fails closed if one ever reaches
       * mutation planning.
       */
      readonly path: string;
      readonly exists: true;
      readonly type: 'unmanaged';
      readonly mode: null;
      readonly digest: null;
      readonly contentBase64: null;
      readonly unmanagedReason: 'symlink' | 'oversize';
    };

export interface InitAuthoredSnapshot {
  /** Existing tree entries plus explicit present/missing target observations. */
  readonly records: readonly InitAuthoredSnapshotRecord[];
  /** Generated/dependency roots preserved opaquely without following or snapshotting them. */
  readonly opaquePaths: readonly string[];
  /** Classification derived from these exact snapshot observations. */
  readonly workingDirState: InitAuthoredWorkingDirState;
  /**
   * Observed posture of the (owner-verified) project root: 'group-writable'
   * on umask-002 layouts. Provenance only — acceptance already happened.
   */
  readonly projectRootPosture: 'strict' | 'group-writable';
}

export interface RenderedInitToolScaffold extends RenderedToolScaffold {
  /**
   * The live descriptor supplied a scaffoldExamples hook. Existing Init creates
   * that Tool's declared user directories even when the hook renders no files.
   */
  readonly createsExampleDirectories: boolean;
}

export interface BuildInitAuthoredPlanInput {
  readonly languages: readonly RuntimePromotionLanguage[];
  readonly mode: InitAuthoredMode;
  readonly toolScaffolds: readonly RenderedInitToolScaffold[];
  readonly snapshot: InitAuthoredSnapshot;
}

/**
 * Exact blobs are retained as canonical base64 strings rather than mutable
 * Buffers. They are deliberately absent from the replay manifest.
 */
export interface InitAuthoredPlanBlobs {
  readonly desired: Readonly<Record<string, string>>;
  readonly preimage: Readonly<Record<string, string>>;
}

export interface InitAuthoredPlan {
  readonly inputs: InitAuthoredNormalizedInputs;
  readonly mutations: readonly InitAuthoredMutation[];
  readonly replayManifest: AuthoredReplayManifest;
  readonly replayManifestBytes: string;
  readonly replayManifestDigest: string;
  readonly digest: string;
  readonly aggregateBlobBytes: number;
  readonly blobs: InitAuthoredPlanBlobs;
  /**
   * Attempt-local compatibility projection for the Init presenter. It is never
   * serialized into the replay manifest and is intentionally absent when a
   * later process reconstructs a plan from durable recovery artifacts.
   */
  readonly presentation?: {
    readonly preExistingFiles: readonly PreExistingFile[];
    readonly agentGuidance: AgentGuidanceResult;
    readonly workingDirState: InitAuthoredWorkingDirState;
  };
}

export interface InitAuthoredSnapshotHooks {
  /** Fault-injection seam called after bytes are read but before revalidation. */
  readonly afterFileRead?: (projectRelativePath: string) => void;
  /** Fault-injection seam called after a directory listing but before revalidation. */
  readonly afterDirectoryRead?: (projectRelativePath: string) => void;
}

export interface ReadInitAuthoredSnapshotInput {
  readonly projectRoot: string;
  /** Every non-tree path whose present/absent preimage must be proven. */
  readonly targetPaths: readonly string[];
  readonly hooks?: InitAuthoredSnapshotHooks;
}

export interface CreateInitAuthoredPlanInput {
  readonly projectRoot: string;
  readonly languages: readonly RuntimePromotionLanguage[];
  readonly mode: InitAuthoredMode;
  readonly toolScaffolds: readonly ToolScaffold[];
  readonly hooks?: InitAuthoredSnapshotHooks;
}

/** @throws {Error} Always; the authored plan violates a required invariant. */
/**
 * @throws {ConfigurationError} Always — authored-plan refusals are project
 * configuration/state problems the user fixes (exit class 2), never runtime
 * faults (the old bare Error degraded to exit 1).
 */
export function authoredPlanFailure(message: string): never {
  throw new ConfigurationError(`Invalid Init authored plan: ${message}`, {
    code: OPTION_INVALID.code,
    definition: OPTION_INVALID,
    metadata: { condition: 'authored-plan' },
  });
}

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Hash bounded byte segments without allocating one aggregate Buffer. */
export function sha256Parts(values: readonly (string | Uint8Array)[]): string {
  const digest = createHash('sha256');
  for (const value of values) digest.update(value);
  return digest.digest('hex');
}

export function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function pathDepth(value: string): number {
  return value.split('/').length;
}

export function isRuntimeAuthoredPath(value: string): boolean {
  return value === 'opensip-cli/.runtime' || value.startsWith('opensip-cli/.runtime/');
}

export function normalizeProjectRelativePath(value: string): string {
  if (
    value.length === 0 ||
    value !== value.normalize('NFC') ||
    value.includes('\\') ||
    value.includes('\0') ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === '.' ||
    value === '..' ||
    value.startsWith('../') ||
    value.endsWith('/') ||
    Buffer.byteLength(value, 'utf8') > INIT_AUTHORED_PLAN_CAPS.maxPathBytes
  ) {
    authoredPlanFailure(`unsafe or noncanonical project-relative path '${value}'`);
  }
  for (const segment of value.split('/')) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      authoredPlanFailure(`unsafe project-relative path '${value}'`);
    }
  }
  if (isRuntimeAuthoredPath(value)) {
    authoredPlanFailure('opensip-cli/.runtime is immutable authored-plan state');
  }
  if (pathDepth(value) > INIT_AUTHORED_PLAN_CAPS.maxTraversalDepth) {
    authoredPlanFailure(`path depth exceeds ${INIT_AUTHORED_PLAN_CAPS.maxTraversalDepth}`);
  }
  return value;
}

export function caseFoldPath(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

export function normalizeLanguages(
  languages: readonly RuntimePromotionLanguage[],
  options: { readonly allowEmpty?: boolean } = {},
): readonly RuntimePromotionLanguage[] {
  const selected = new Set<string>(languages);
  if (
    (selected.size === 0 && options.allowEmpty !== true) ||
    selected.size !== languages.length ||
    languages.some((language) => !RUNTIME_PROMOTION_LANGUAGES.includes(language))
  ) {
    authoredPlanFailure(
      options.allowEmpty === true
        ? 'languages must be a supported set'
        : 'languages must be a nonempty supported set',
    );
  }
  return RUNTIME_PROMOTION_LANGUAGES.filter((language) => selected.has(language));
}

export function validateMode(value: string): asserts value is InitAuthoredMode {
  if (!(RUNTIME_PROMOTION_AUTHORED_MODES as readonly string[]).includes(value)) {
    authoredPlanFailure(`unsupported authored mode '${value}'`);
  }
}

export function validateAuthoredToolIdentity(identity: ToolScaffoldIdentity, field: string): void {
  const values = [
    ['stableId', identity.stableId],
    ['name', identity.name],
    ['version', identity.version],
  ] as const;
  for (const [name, value] of values) {
    if (
      value.length === 0 ||
      value !== value.trim() ||
      [...value].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 0x1f || code === 0x7f;
      }) ||
      Buffer.byteLength(value, 'utf8') > INIT_AUTHORED_PLAN_CAPS.maxIdentityBytes
    ) {
      authoredPlanFailure(`${field}.${name} is invalid`);
    }
  }
}

export function normalizeToolIdentities(
  scaffolds: readonly RenderedInitToolScaffold[],
): readonly ToolScaffoldIdentity[] {
  const stableIds = new Set<string>();
  const names = new Set<string>();
  return scaffolds.map((scaffold, index) => {
    validateAuthoredToolIdentity(scaffold.identity, `tools[${String(index)}]`);
    if (stableIds.has(scaffold.identity.stableId) || names.has(scaffold.identity.name)) {
      authoredPlanFailure('Tool stable ids and names must be unique');
    }
    stableIds.add(scaffold.identity.stableId);
    names.add(scaffold.identity.name);
    return { ...scaffold.identity };
  });
}

export function directoryDigest(mode: number): string {
  return sha256Bytes(`opensip-init-directory\0${String(mode)}`);
}

export function absentPathState(): InitAuthoredPathState {
  return { exists: false, type: null, mode: null, digest: null };
}

export function sameAuthoredPathState(
  left: InitAuthoredPathState,
  right: InitAuthoredPathState,
): boolean {
  return (
    left.exists === right.exists &&
    left.type === right.type &&
    left.mode === right.mode &&
    left.digest === right.digest
  );
}

export function stateFromSnapshot(record: InitAuthoredSnapshotRecord): InitAuthoredPathState {
  if (record.type === 'unmanaged') {
    // Unmanaged guidance never becomes a mutation preimage — planning one
    // would risk a write through a symlink.
    authoredPlanFailure(`${record.path} is unmanaged and cannot be planned`);
  }
  return {
    exists: record.exists,
    type: record.type,
    mode: record.mode,
    digest: record.digest,
  };
}
