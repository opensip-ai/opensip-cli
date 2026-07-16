import { createHash } from 'node:crypto';

import { compareCodePoint as compareCodePoints } from './code-point-order.js';

import type { RunStepReference } from './run-context.js';

export const PROJECT_INVENTORY_SCHEMA_VERSION = 1 as const;
export const TEST_SELECTION_SCHEMA_VERSION = 1 as const;
export const TASK_CONTEXT_MANIFEST_SCHEMA_VERSION = 1 as const;
export const MAX_TASK_CONTEXT_PLANES = 16;
export const MAX_TASK_CONTEXT_MANIFEST_BYTES = 64 * 1024;
export const MAX_TASK_CONTEXT_FILES = 128;
export const TEST_SELECTION_PLANE_KIND = 'test-selection' as const;

export type FileRole =
  'production' | 'test' | 'configuration' | 'documentation' | 'generated' | 'build' | 'unknown';
export type FactProvenanceSource = 'target' | 'manifest' | 'convention' | 'filesystem';

export interface FactProvenance {
  readonly source: FactProvenanceSource;
  readonly detail: string;
}

export interface ProjectFact {
  readonly packageManager?: string;
  readonly workspacePatterns: readonly string[];
  readonly languages: readonly string[];
  readonly fileCount: number;
  readonly packageCount: number;
  readonly configIdentity: string;
}

export type EvidenceReadSupportStatus = 'supported' | 'unsupported' | 'unknown';

export interface FileEvidenceSupport {
  readonly callable: EvidenceReadSupportStatus;
  readonly declaration: EvidenceReadSupportStatus;
  readonly reference: EvidenceReadSupportStatus;
}

export interface VerificationCommand {
  readonly tier: 'focused' | 'package' | 'full';
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly basis: string;
}

export interface PackageFact {
  readonly name: string;
  readonly root: string;
  readonly private: boolean;
  readonly exports: readonly string[];
  readonly bins: readonly string[];
  readonly verificationCommands: readonly VerificationCommand[];
  readonly provenance: readonly FactProvenance[];
}

export interface FileFact {
  readonly path: string;
  readonly size: number;
  readonly modifiedMs: number;
  readonly roles: readonly FileRole[];
  readonly targets: readonly string[];
  readonly languages: readonly string[];
  readonly evidenceSupport: FileEvidenceSupport;
  readonly packageName?: string;
  readonly provenance: readonly FactProvenance[];
}

export interface ContextCoverage {
  readonly status: 'complete' | 'partial' | 'unavailable';
  readonly reasonCodes: readonly string[];
  readonly observed: number;
  readonly total?: number;
}

export interface ProjectInventorySnapshot {
  readonly schemaVersion: typeof PROJECT_INVENTORY_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly metadataIdentity: string;
  readonly project: ProjectFact;
  readonly packages: readonly PackageFact[];
  readonly files: readonly FileFact[];
  readonly coverage: ContextCoverage;
}

export type TestSelectionBasis =
  'direct-call' | 'transitive-call' | 'module-import' | 'target-convention' | 'co-located';

export interface SelectedTest {
  readonly path: string;
  readonly basis: TestSelectionBasis;
  readonly confidence: 'exact' | 'high' | 'medium' | 'low';
  readonly proof: readonly string[];
  readonly observed: false;
}

export interface TestSelectionTrust {
  readonly status: 'complete' | 'partial' | 'fallback';
  readonly reasonCodes: readonly string[];
  readonly fallbackTier: 'focused' | 'package' | 'full';
}

export interface TestSelectionSnapshot {
  readonly schemaVersion: typeof TEST_SELECTION_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly files: readonly string[];
  readonly tests: readonly SelectedTest[];
  readonly commands: readonly VerificationCommand[];
  readonly uncoveredFiles: readonly string[];
  readonly trust: TestSelectionTrust;
  readonly graphIdentity: string;
  readonly inventoryIdentity: string;
}

export type TaskContextReadiness = 'ready' | 'degraded' | 'unavailable';
export type TaskContextPlaneStatus =
  'rebuilt' | 'reused' | 'partial' | 'unsupported' | 'failed' | 'cancelled';
export type TaskContextPlaneKind = 'inventory' | 'graph' | typeof TEST_SELECTION_PLANE_KIND;

export interface TaskContextSourceIdentity {
  readonly configIdentity: string;
  readonly gitHead?: string;
  readonly worktreeIdentity?: string;
  readonly dirty?: boolean;
  readonly status: 'captured' | 'unsupported' | 'failed';
  readonly reasonCodes: readonly string[];
}

export interface TaskContextSnapshotPointer {
  readonly owner: 'graph';
  readonly kind: TaskContextPlaneKind;
  readonly id: string;
  readonly schemaVersion: number;
}

export interface TaskContextPlane {
  readonly kind: TaskContextPlaneKind;
  readonly required: boolean;
  readonly status: TaskContextPlaneStatus;
  readonly producer: {
    readonly toolId: string;
    readonly command: string;
    readonly version: string;
  };
  readonly pointer?: TaskContextSnapshotPointer;
  readonly step: RunStepReference;
  readonly freshness: {
    readonly status: 'current' | 'stale' | 'unknown';
    readonly reasonCodes: readonly string[];
  };
  readonly coverage: ContextCoverage;
  readonly caps: {
    readonly status: 'not-hit' | 'hit' | 'unknown';
    readonly reasonCodes: readonly string[];
  };
  readonly reasonCodes: readonly string[];
  readonly followUpReads: readonly string[];
}

export interface TaskContextFileScope {
  readonly mode: 'project' | 'explicit';
  readonly fileCount: number;
  readonly filesIdentity: string;
}

export interface TaskContextManifest {
  readonly schemaVersion: typeof TASK_CONTEXT_MANIFEST_SCHEMA_VERSION;
  readonly suite: 'agent-context';
  readonly runId: string;
  readonly createdAt: string;
  readonly projectIdentity: string;
  readonly readiness: TaskContextReadiness;
  readonly sourceStart: TaskContextSourceIdentity;
  readonly sourceEnd: TaskContextSourceIdentity;
  readonly fileScope: TaskContextFileScope;
  readonly graphIdentity?: string;
  readonly inventoryIdentity?: string;
  readonly planes: readonly TaskContextPlane[];
  readonly reasonCodes: readonly string[];
  readonly nextActions: readonly string[];
}

function canonicalIdentityValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalIdentityValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareCodePoints)
      .map((key) => [key, canonicalIdentityValue((value as Record<string, unknown>)[key])]),
  );
}

function contextSnapshotDigest(prefix: 'm1' | 'i1' | 'ts1', value: unknown): string {
  return `${prefix}:${createHash('sha256')
    .update(JSON.stringify(canonicalIdentityValue(value)), 'utf8')
    .digest('hex')}`;
}

export function buildProjectInventorySnapshotIdentities(
  input: Omit<ProjectInventorySnapshot, 'snapshotId' | 'metadataIdentity'>,
): { readonly metadataIdentity: string; readonly snapshotId: string } {
  const metadataIdentity = contextSnapshotDigest('m1', input);
  return {
    metadataIdentity,
    snapshotId: contextSnapshotDigest('i1', { ...input, metadataIdentity }),
  };
}

export function projectInventorySnapshotIdentityMatches(
  snapshot: ProjectInventorySnapshot,
): boolean {
  const { snapshotId, metadataIdentity, ...input } = snapshot;
  const expected = buildProjectInventorySnapshotIdentities(input);
  return snapshotId === expected.snapshotId && metadataIdentity === expected.metadataIdentity;
}

export function buildTestSelectionSnapshotIdentity(
  input: Omit<TestSelectionSnapshot, 'snapshotId'>,
): string {
  return contextSnapshotDigest('ts1', input);
}

export function testSelectionSnapshotIdentityMatches(snapshot: TestSelectionSnapshot): boolean {
  const { snapshotId, ...input } = snapshot;
  return snapshotId === buildTestSelectionSnapshotIdentity(input);
}
