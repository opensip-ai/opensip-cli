import { byCodePoint } from './freeze.js';

import type { FileRoleTargetProjection } from './file-roles.js';
import type { FactProvenance, FileFact, FileRole } from '@opensip-cli/contracts';

export interface BoundedTarget extends FileRoleTargetProjection {
  readonly languages: readonly string[];
}

export interface PendingFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly targets: BoundedTarget[];
  readonly structuralRoles?: readonly FileRole[];
  readonly structuralProvenance?: readonly FactProvenance[];
}

export interface StructuralFileDiscovery {
  readonly pending: readonly PendingFile[];
  readonly reasons: readonly string[];
}

export interface TargetFileResolution {
  readonly pending: readonly PendingFile[];
  readonly reasons: readonly string[];
  readonly available: boolean;
}

export interface FileDiscovery {
  readonly files: readonly FileFact[];
  readonly reasons: readonly string[];
  readonly available: boolean;
}

export function compareBoundedTargets(left: BoundedTarget, right: BoundedTarget): number {
  return byCodePoint(left.name, right.name);
}
