import { currentScope, toPosixRelative } from '@opensip-cli/core';
import { minimatch } from 'minimatch';

import type { TargetConventionsView } from '@opensip-cli/core';

/** Target convention match used by checks to explain why a finding was suppressed. */
export interface TargetConventionMatch {
  /** Convention category that matched the inspected file or export. */
  readonly kind: 'alwaysUsed' | 'usedExport';
  /** Target name that supplied the matching convention. */
  readonly targetName: string;
  /** Project-relative convention glob that matched. */
  readonly pattern: string;
}

/** Return the first `alwaysUsed` target convention that matches a file. */
export function matchConventionAlwaysUsed(
  filePath: string,
  cwd = process.cwd(),
): TargetConventionMatch | undefined {
  const match = findConventionMatch(filePath, cwd, (conventions) => conventions.alwaysUsed ?? []);
  return match ? { ...match, kind: 'alwaysUsed' } : undefined;
}

/** Return the first `usedExports` target convention that matches a file/export pair. */
export function matchConventionUsedExport(
  filePath: string,
  exportName: string,
  cwd = process.cwd(),
): TargetConventionMatch | undefined {
  const relativePath = toPosixRelative(cwd, filePath);
  for (const target of currentScope()?.targets?.getAll() ?? []) {
    for (const usedExport of target.config.conventions?.usedExports ?? []) {
      if (
        usedExport.names.includes(exportName) &&
        minimatch(relativePath, usedExport.file, { dot: true })
      ) {
        return {
          kind: 'usedExport',
          targetName: target.config.name,
          pattern: usedExport.file,
        };
      }
    }
  }
  return undefined;
}

function findConventionMatch(
  filePath: string,
  cwd: string,
  readPatterns: (conventions: TargetConventionsView) => readonly string[],
): Omit<TargetConventionMatch, 'kind'> | undefined {
  const relativePath = toPosixRelative(cwd, filePath);
  for (const target of currentScope()?.targets?.getAll() ?? []) {
    const conventions = target.config.conventions;
    if (!conventions) continue;
    for (const pattern of readPatterns(conventions)) {
      if (minimatch(relativePath, pattern, { dot: true })) {
        return { targetName: target.config.name, pattern };
      }
    }
  }
  return undefined;
}
