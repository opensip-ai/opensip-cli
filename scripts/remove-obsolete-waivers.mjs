#!/usr/bin/env node
/**
 * Remove @fitness-ignore directives for slugs whose checks were improved.
 * Only touches packages source trees (not tests, fixtures, or dist).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);
const SLUGS = [
  'batch-operation-limits',
  'unbounded-memory',
  'context-mutation',
  'concurrency-safety',
];
const IGNORE_RE = new RegExp(
  `^\\s*//\\s*@fitness-ignore-(?:file|next-line)\\s+(?:${SLUGS.join('|')})\\b`,
);

function walk(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/^packages\/.*\/src\/.*\.(ts|tsx)$/.test(relative(REPO_ROOT, p))) out.push(p);
  }
  return out;
}

function isProductionSrc(rel) {
  return (
    !rel.includes('__tests__') && !rel.includes('__fixtures__') && !/\.test\.(ts|tsx)$/.test(rel)
  );
}

let changed = 0;
let removed = 0;

for (const abs of walk(join(REPO_ROOT, 'packages'))) {
  const rel = relative(REPO_ROOT, abs);
  if (!isProductionSrc(rel)) continue;

  const lines = readFileSync(abs, 'utf8').split('\n');
  const next = lines.filter((line) => !IGNORE_RE.test(line));
  if (next.length === lines.length) continue;

  writeFileSync(abs, next.join('\n'));
  changed++;
  removed += lines.length - next.length;
  console.log(`  ${rel}: -${lines.length - next.length}`);
}

console.log(`Removed ${removed} waiver(s) across ${changed} file(s).`);
