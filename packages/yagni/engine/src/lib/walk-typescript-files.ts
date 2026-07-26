import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'coverage',
  '.turbo',
  '.opensip-cli',
]);

const SOURCE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;

// eslint-disable-next-line sonarjs/cognitive-complexity -- iterative directory walk with test-path and skip-dir guards
export function walkTypeScriptFiles(
  root: string,
  includeTests: boolean,
  roots?: readonly string[],
): string[] {
  const out = new Set<string>();
  const stack = roots !== undefined && roots.length > 0 ? [...roots] : [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // @swallow-ok absence probe during a source walk — an unreadable directory contributes no files, and yagni is an advisory audit that must not fail a run over one
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXT.test(entry.name)) continue;
      if (!includeTests && isTestPath(full)) continue;
      out.add(full);
    }
  }
  return [...out].sort();
}

function isTestPath(filePath: string): boolean {
  return (
    /[/\\]__tests__[/\\]/.test(filePath) ||
    /\.test\.(?:[cm]?[jt]s|[jt]sx)$/.test(filePath) ||
    /\.spec\.(?:[cm]?[jt]s|[jt]sx)$/.test(filePath)
  );
}
