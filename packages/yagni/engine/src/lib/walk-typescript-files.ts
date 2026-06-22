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

const TS_EXT = /\.(ts|tsx|mts|cts)$/;

// eslint-disable-next-line sonarjs/cognitive-complexity -- iterative directory walk with test-path and skip-dir guards
export function walkTypeScriptFiles(
  root: string,
  includeTests: boolean,
  roots?: readonly string[],
): string[] {
  const out: string[] = [];
  const stack = roots !== undefined && roots.length > 0 ? [...roots] : [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !TS_EXT.test(entry.name)) continue;
      if (!includeTests && isTestPath(full)) continue;
      out.push(full);
    }
  }
  return out.sort();
}

function isTestPath(filePath: string): boolean {
  if (/[/\\]__tests__[/\\](?:fixtures|__fixtures__)[/\\]/.test(filePath)) return false;
  return (
    /[/\\]__tests__[/\\]/.test(filePath) ||
    /\.test\.(ts|tsx|mts|cts)$/.test(filePath) ||
    /\.spec\.(ts|tsx|mts|cts)$/.test(filePath)
  );
}
