import { readdirSync, statSync } from 'node:fs';
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

export function walkTypeScriptFiles(root: string, includeTests: boolean): string[] {
  const out: string[] = [];
  const stack = [root];
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

export function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}