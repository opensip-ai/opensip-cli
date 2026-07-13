import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { isPathInside, tryCatch } from '@opensip-cli/core';
import { parseDocument } from 'yaml';

import { byCodePoint } from './freeze.js';
import { MAX_WORKSPACE_PATTERNS } from './types.js';

const CONTROL_CHARACTER = /\p{Cc}/u;
const WORKSPACE_MANIFEST_INVALID = 'workspace-manifest-invalid';

function safeWorkspacePattern(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1024 ||
    CONTROL_CHARACTER.test(value) ||
    value.includes('\\')
  ) {
    return;
  }
  const negative = value.startsWith('!');
  const normalized = (negative ? value.slice(1) : value).replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    return;
  }
  return negative ? `!${normalized}` : normalized;
}

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
    const patterns = packages
      .map(safeWorkspacePattern)
      .filter((pattern): pattern is string => pattern !== undefined);
    if (patterns.length !== packages.length) reasons.add('workspace-pattern-invalid');
    if (patterns.length > MAX_WORKSPACE_PATTERNS) reasons.add('manifest-workspace-cap-reached');
    return [...new Set(patterns)].sort(byCodePoint).slice(0, MAX_WORKSPACE_PATTERNS);
  });
  if (parsed.ok) return parsed.value;
  reasons.add(WORKSPACE_MANIFEST_INVALID);
  return [];
}
