import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { isPathInside, tryCatch } from '@opensip-cli/core';
import { parseDocument } from 'yaml';

import { MAX_WORKSPACE_PATTERNS } from './types.js';
import { projectWorkspacePatterns } from './workspace-patterns.js';

const WORKSPACE_MANIFEST_INVALID = 'workspace-manifest-invalid';

/** Read only bounded package globs from pnpm's workspace manifest. */
export function pnpmWorkspacePatterns(
  projectRoot: string,
  maximumBytes: number,
  reasons: Set<string>,
): readonly string[] {
  const path = join(projectRoot, 'pnpm-workspace.yaml');
  if (!existsSync(path)) return [];
  const parsed = tryCatch(() => {
    const canonical = realpathSync(path);
    if (!isPathInside(canonical, projectRoot) || statSync(canonical).size > maximumBytes) {
      reasons.add(WORKSPACE_MANIFEST_INVALID);
      return [];
    }
    const document = parseDocument(readFileSync(canonical, 'utf8'));
    if (document.errors.length > 0) {
      reasons.add(WORKSPACE_MANIFEST_INVALID);
      return [];
    }
    const value = document.toJS({ maxAliasCount: 0 }) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      reasons.add(WORKSPACE_MANIFEST_INVALID);
      return [];
    }
    const packages = (value as Record<string, unknown>).packages;
    if (!Array.isArray(packages)) {
      reasons.add(WORKSPACE_MANIFEST_INVALID);
      return [];
    }
    const projection = projectWorkspacePatterns(packages, MAX_WORKSPACE_PATTERNS);
    if (projection.invalid) reasons.add('workspace-pattern-invalid');
    if (projection.capped) reasons.add('manifest-workspace-cap-reached');
    return projection.values;
  });
  if (parsed.ok) return parsed.value;
  reasons.add(WORKSPACE_MANIFEST_INVALID);
  return [];
}
