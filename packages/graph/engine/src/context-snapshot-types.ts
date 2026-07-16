/** Neutral context-snapshot contracts shared by graph persistence and graph/read. */

import type { ProjectInventorySnapshot, TestSelectionSnapshot } from '@opensip-cli/contracts';

export type ContextSnapshotKind = 'inventory' | 'test-selection';
export type ContextSnapshotPayload = ProjectInventorySnapshot | TestSelectionSnapshot;

export interface ContextSnapshotSaveInput {
  readonly id: string;
  readonly kind: ContextSnapshotKind;
  readonly schemaVersion: number;
  readonly producerVersion: string;
  readonly createdAt: string;
  readonly sourceIdentity: string;
  readonly configIdentity: string;
  readonly payload: ContextSnapshotPayload;
}

export interface ContextSnapshotRecord {
  readonly id: string;
  readonly kind: string;
  readonly schemaVersion: number;
  readonly producerVersion: string;
  readonly createdAt: string;
  readonly sourceIdentity: string;
  readonly configIdentity: string;
  readonly byteCount: number;
  readonly payload: unknown;
}

export interface ContextSnapshotSaveResult {
  readonly status: 'rebuilt' | 'reused';
  readonly snapshot: ContextSnapshotRecord;
}

/** Structural graph-scope seam; the concrete repository never crosses it. */
export interface ContextSnapshotAccessor {
  save(input: ContextSnapshotSaveInput): ContextSnapshotSaveResult;
  get(id: string): ContextSnapshotRecord | null;
  latest(kind: ContextSnapshotKind): ContextSnapshotRecord | null;
}
