#!/usr/bin/env node
//
// Extract slug + description + tags from every defineCheck() / defineRegexListCheck()
// call across the fitness check packs. Output: JSON to stdout.
//
// Used to seed docs/architecture/80-reference/04-checks-index.md. Not a perfect
// AST parser — relies on the project convention that slug/description/tags are
// inline string literals on their own lines. Sufficient for the first cut;
// a TypeScript-AST-based generator would replace this if/when the index goes
// fully auto-generated.
//
// Usage:
//   node tools/extract-checks-metadata.mjs > /tmp/checks.json
//

import { promises as fs } from 'node:fs';
import { dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(__filename));

const PACKS = [
  'checks-universal',
  'checks-typescript',
  'checks-python',
  'checks-go',
  'checks-java',
  'checks-cpp',
  'checks-rust',
];

async function walkDir(dir) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      out.push(...(await walkDir(p)));
    } else if (e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.tsx'))) {
      out.push(p);
    }
  }
  return out;
}

function parseCheckBlocks(content, filePath) {
  // Strip line comments (// ...) cheaply so we don't match commented-out
  // slugs in fileoverview blocks.
  const stripped = content
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

  // Each defineCheck({...}) or defineRegexListCheck({...}) call: find slug,
  // description, tags inside it. We're permissive — multiple calls per file
  // are listed separately. CHECK_SLUG constant references are flagged and
  // resolved via a second pass.
  const blocks = [];
  // Match the call up to the next `})` at the matching brace level. Naive
  // brace-counting is good enough for our convention.
  const callRegex = /(defineCheck|defineRegexListCheck)\s*\(\s*\{/g;
  let match;
  while ((match = callRegex.exec(stripped)) !== null) {
    const startIdx = match.index + match[0].length;
    let depth = 1;
    let endIdx = startIdx;
    while (endIdx < stripped.length && depth > 0) {
      const ch = stripped[endIdx];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      endIdx++;
    }
    const block = stripped.slice(startIdx, endIdx);
    const slugMatch = block.match(/(?:^|\s)slug:\s*(['"])([^'"]+)\1/);
    const descMatch = block.match(/(?:^|\s)description:\s*(['"])([^'"]+)\1/);
    const tagsMatch = block.match(/(?:^|\s)tags:\s*\[([^\]]*)\]/);
    let tags = [];
    if (tagsMatch) {
      tags = [...tagsMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    }
    if (slugMatch) {
      blocks.push({
        slug: slugMatch[2],
        description: descMatch ? descMatch[2] : null,
        tags,
        file: relative(REPO_ROOT, filePath),
      });
    }
  }

  // Resolve CHECK_SLUG / CHECK_DESCRIPTION constant references in files that
  // use them. Convention: `const CHECK_SLUG = '...'`, `const CHECK_DESCRIPTION = '...'`.
  if (blocks.some((b) => !b.description || !b.slug)) {
    const slugConst = stripped.match(/CHECK_SLUG\s*=\s*(['"])([^'"]+)\1/);
    const descConst = stripped.match(/CHECK_DESCRIPTION\s*=\s*(['"])([^'"]+)\1/);
    for (const b of blocks) {
      if (!b.slug && slugConst) b.slug = slugConst[2];
      if (!b.description && descConst) b.description = descConst[2];
    }
  }

  return blocks;
}

async function main() {
  const all = [];
  for (const pack of PACKS) {
    const dir = `${REPO_ROOT}/packages/fitness/${pack}/src/checks`;
    const files = await walkDir(dir);
    for (const f of files) {
      try {
        const content = await fs.readFile(f, 'utf8');
        const blocks = parseCheckBlocks(content, f);
        for (const b of blocks) {
          all.push({ ...b, pack });
        }
      } catch (e) {
        process.stderr.write(`warn: could not read ${f}: ${e.message}\n`);
      }
    }
  }
  process.stdout.write(JSON.stringify(all, null, 2) + '\n');
}

main().catch((e) => {
  process.stderr.write(`error: ${e.message}\n`);
  process.exit(1);
});
