import { byCodePoint } from './freeze.js';

import type { FactProvenance, FileFact, FileRole } from '@opensip-cli/contracts';
import type { TargetView } from '@opensip-cli/core';

export interface BoundedTarget {
  readonly view: TargetView;
  readonly name: string;
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
