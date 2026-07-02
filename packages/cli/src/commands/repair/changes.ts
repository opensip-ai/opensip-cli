import type { RepairApplyResult } from '@opensip-cli/contracts';

export function changedFilesForRepair(result: RepairApplyResult): readonly string[] {
  return [
    ...new Set<string>(
      result.changes
        .filter((change) => change.status === 'modified' || result.status === 'already-applied')
        .map((change) => change.filePath),
    ),
  ];
}
