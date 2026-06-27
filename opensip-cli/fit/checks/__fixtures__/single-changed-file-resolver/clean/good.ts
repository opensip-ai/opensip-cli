import { resolveChangedFiles } from '@opensip-cli/core';

export function getChanged(cwd: string): readonly string[] {
  const result = resolveChangedFiles(cwd);
  return result.ok ? result.files : [];
}