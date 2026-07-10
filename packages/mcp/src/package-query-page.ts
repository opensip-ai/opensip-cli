/** Deterministic paging and grouping for package dependency read DTOs. */

import {
  codePointSortKey,
  packageCallEvidenceStableKey,
  packageDependencyStableKey,
  packageImportEvidenceStableKey,
  type PackageCallEvidenceRow,
  type PackageDependencyEvidence,
  type PackageImportEvidenceRow,
} from '@opensip-cli/graph/read';

import { groupRows, pageRows, type GroupSummary, type PageInput } from './graph-query-page.js';

import type { PackageCyclesDto } from './graph-read-port.js';
import type { McpReadError } from './mcp-error.js';
import type { Result } from '@opensip-cli/core';

type GroupBy = 'none' | 'package' | 'file';
type DependencyRow = PackageCallEvidenceRow | PackageImportEvidenceRow;
type WhyEvidence = PackageDependencyEvidence;
type CycleComponent = PackageCyclesDto['components'][number];

export interface PackagePage<T> {
  readonly rows: readonly T[];
  readonly nextCursor?: string;
  readonly groups?: readonly GroupSummary[];
  readonly groupTruncated: boolean;
}

function dependencyGroupKey(row: DependencyRow, mode: Exclude<GroupBy, 'none'>): string {
  if (mode === 'package') return row.fromPackage;
  const sample = row.sample[0];
  if (sample === undefined) return '<unlocated>';
  return sample.kind === 'call' ? sample.source.file : sample.importSite.filePath;
}

function whyGroupKey(row: WhyEvidence, mode: Exclude<GroupBy, 'none'>): string {
  if (mode === 'package') return row.fromPackage;
  return row.kind === 'call' ? row.source.file : row.importSite.filePath;
}

function cycleStableKey(row: CycleComponent): string {
  return `cycle|${row.packages.map(codePointSortKey).join('|')}`;
}

function cycleGroupKey(row: CycleComponent, mode: Exclude<GroupBy, 'none'>): string {
  return mode === 'package' ? row.packages.join(' -> ') : '<not-applicable>';
}

function pageAndGroup<T>(
  rows: readonly T[],
  input: PageInput,
  groupBy: GroupBy,
  stableKey: (row: T) => string,
  groupKey: (row: T, mode: Exclude<GroupBy, 'none'>) => string,
): Result<PackagePage<T>, McpReadError> {
  const paged = pageRows(rows, input, stableKey);
  if (!paged.ok) return paged;
  const grouped = groupRows(rows, groupBy, groupKey);
  return {
    ok: true,
    value: {
      rows: paged.value.rows,
      ...(paged.value.nextCursor === undefined ? {} : { nextCursor: paged.value.nextCursor }),
      ...(grouped.groups === undefined ? {} : { groups: grouped.groups }),
      groupTruncated: grouped.groupTruncated,
    },
  };
}

export function pagePackageDependencies(
  rows: readonly DependencyRow[],
  input: PageInput,
  groupBy: GroupBy,
): Result<PackagePage<DependencyRow>, McpReadError> {
  return pageAndGroup(rows, input, groupBy, packageDependencyStableKey, dependencyGroupKey);
}

export function pageWhyDepends(
  rows: readonly WhyEvidence[],
  input: PageInput,
  groupBy: GroupBy,
): Result<PackagePage<WhyEvidence>, McpReadError> {
  return pageAndGroup(
    rows,
    input,
    groupBy,
    (row) =>
      row.kind === 'call' ? packageCallEvidenceStableKey(row) : packageImportEvidenceStableKey(row),
    whyGroupKey,
  );
}

export function pagePackageCycles(
  rows: readonly CycleComponent[],
  input: PageInput,
  groupBy: GroupBy,
): Result<PackagePage<CycleComponent>, McpReadError> {
  return pageAndGroup(rows, input, groupBy, cycleStableKey, cycleGroupKey);
}
