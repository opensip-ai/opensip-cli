import { resolveChangedFiles } from '@opensip-cli/core';

import { hasSelector } from './propagated-options.js';

import type { SuiteRunScope } from '@opensip-cli/contracts';

export interface ResolveSuiteScopeInput {
  readonly cwd: string;
  readonly suiteOpts: Readonly<Record<string, unknown>>;
  readonly defaultChanged: boolean;
}

function suiteScopeSince(input: Readonly<Record<string, unknown>>): string | undefined {
  return typeof input.since === 'string' && input.since !== '' ? input.since : undefined;
}

function suiteScopeFileCount(input: Readonly<Record<string, unknown>>): number | undefined {
  return Array.isArray(input.files) && input.files.length > 0 ? input.files.length : undefined;
}

function fallbackNotice(message: string): string {
  const normalized = message.trim();
  return normalized.length === 0
    ? 'Unable to resolve changed files; running the full scope'
    : `${normalized}; running the full scope`;
}

function resolveExplicitSuiteScope(input: ResolveSuiteScopeInput): SuiteRunScope {
  const since = suiteScopeSince(input.suiteOpts);
  const fileCount = suiteScopeFileCount(input.suiteOpts);
  if (fileCount !== undefined) {
    return {
      mode: 'changed',
      source: 'explicit',
      changedFiles: fileCount,
    };
  }

  const resolved = resolveChangedFiles(input.cwd, since === undefined ? undefined : { since });
  return {
    mode: 'changed',
    source: 'explicit',
    ...(since === undefined ? {} : { ref: since }),
    ...(resolved.ok ? { changedFiles: resolved.files.length } : {}),
  };
}

export function resolveSuiteScope(input: ResolveSuiteScopeInput): SuiteRunScope {
  if (input.suiteOpts.full === true) {
    return { mode: 'full', source: 'explicit' };
  }

  if (hasSelector(input.suiteOpts)) {
    return resolveExplicitSuiteScope(input);
  }

  if (input.defaultChanged) {
    const resolved = resolveChangedFiles(input.cwd);
    if (resolved.ok) {
      return {
        mode: 'changed',
        source: 'default',
        changedFiles: resolved.files.length,
      };
    }
    return {
      mode: 'full',
      source: 'fallback',
      notice: fallbackNotice(resolved.message),
    };
  }

  return { mode: 'full', source: 'default' };
}
