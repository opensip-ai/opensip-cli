#!/usr/bin/env node
//
// Generate docs/public/70-reference/05-checks-index.md from the
// metadata extracted by tools/extract-checks-metadata.mjs.
//
// Why a generator rather than a hand-curated index: the checks corpus, with
// descriptions and tags, is too much to keep in sync by hand. The corpus
// changes every time a new check ships; a generated index keeps the
// docs honest about what's actually in the box. This script is the
// authoritative writer of docs/public/70-reference/05-checks-index.md
// — do not hand-edit that file; edit this generator instead.
//
// Usage:
//   node tools/extract-checks-metadata.mjs > /tmp/checks.json
//   node tools/build-checks-index.mjs /tmp/checks.json > docs/public/70-reference/05-checks-index.md
//
// Or piped:
//   node tools/extract-checks-metadata.mjs | node tools/build-checks-index.mjs - > <output>
//

import { promises as fs } from 'node:fs';

const PACK_DISPLAY = {
  'checks-universal':  { title: 'Universal',  scope: 'Language-agnostic; runs against every project.' },
  'checks-typescript': { title: 'TypeScript', scope: 'TypeScript/JavaScript projects; uses TS-AST analysis.' },
  'checks-python':     { title: 'Python',     scope: 'Python projects.' },
  'checks-go':         { title: 'Go',         scope: 'Go projects.' },
  'checks-java':       { title: 'Java',       scope: 'Java projects.' },
  'checks-cpp':        { title: 'C / C++',    scope: 'C/C++ projects.' },
  'checks-rust':       { title: 'Rust',       scope: 'Rust projects.' },
};

const PACK_ORDER = [
  'checks-universal',
  'checks-typescript',
  'checks-python',
  'checks-go',
  'checks-java',
  'checks-cpp',
  'checks-rust',
];

// Primary tag is the first tag that matches a known category; categories
// are extracted from the source-tree subdirectory names. This is heuristic
// but stable.
const PRIMARY_TAGS = [
  'architecture',
  'security',
  'quality',
  'resilience',
  'documentation',
  'testing',
];

function primaryTag(check) {
  // Prefer a tag that matches our top-level category. Fall back to source path.
  const t = check.tags.find((x) => PRIMARY_TAGS.includes(x));
  if (t) return t;
  for (const candidate of PRIMARY_TAGS) {
    if (check.file.includes(`/${candidate}/`)) return candidate;
  }
  return 'other';
}

function escapeMd(s) {
  if (!s) return '';
  // Escape pipe and backtick within table cells; collapse newlines.
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

function checkLabel(count) {
  return count === 1 ? 'check' : 'checks';
}

async function readInput(arg) {
  if (!arg || arg === '-') {
    // Read stdin
    return new Promise((resolve, reject) => {
      const chunks = [];
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      process.stdin.on('error', reject);
    });
  }
  return fs.readFile(arg, 'utf8');
}

async function main() {
  const raw = await readInput(process.argv[2]);
  const checks = JSON.parse(raw);
  const total = checks.length;

  const today = new Date().toISOString().slice(0, 10);

  const out = [];
  out.push('---');
  out.push('status: current');
  out.push(`last_verified: ${today}`);
  out.push('release: v2.0.x');
  out.push('title: "Checks reference"');
  out.push('audience: [getting-started, ci-integrators, plugin-authors]');
  out.push('purpose: "Browsable index of every built-in fit check, grouped by pack and primary tag. Auto-generated from source by tools/build-checks-index.mjs."');
  out.push('source-files:');
  out.push('  - packages/fitness/checks-universal/src/checks/');
  out.push('  - packages/fitness/checks-typescript/src/checks/');
  out.push('  - packages/fitness/checks-python/src/checks/');
  out.push('  - packages/fitness/checks-go/src/checks/');
  out.push('  - packages/fitness/checks-java/src/checks/');
  out.push('  - packages/fitness/checks-cpp/src/checks/');
  out.push('  - packages/fitness/checks-rust/src/checks/');
  out.push('related-docs:');
  out.push('  - ../00-start/02-show-me-the-loops.md');
  out.push('  - ../50-extend/01-plugin-authoring.md');
  out.push('  - ../50-extend/04-check-pack-architecture.md');
  out.push('---');
  out.push('# Checks reference');
  out.push('');
  out.push(`opensip-tools ships **${total}+ built-in checks** across seven packs. Each check is a single source file that returns violations when the rule is broken. Below: every check by pack, grouped by primary tag, with the one-line description from \`defineCheck\`.`);
  out.push('');
  out.push('> This page is **auto-generated** from the source by [`tools/build-checks-index.mjs`](https://github.com/opensip-ai/opensip-tools/blob/main/tools/build-checks-index.mjs). Do not edit it by hand — edit the check\'s source file (the link in each row), then re-run the generator.');
  out.push('');

  // Per-pack section
  for (const pack of PACK_ORDER) {
    const inPack = checks.filter((c) => c.pack === pack);
    if (inPack.length === 0) continue;
    const display = PACK_DISPLAY[pack];
    out.push('---');
    out.push('');
    out.push(`## ${display.title}  *(${inPack.length} ${checkLabel(inPack.length)})*`);
    out.push('');
    out.push(display.scope);
    out.push('');

    // Group by primary tag
    const byTag = new Map();
    for (const c of inPack) {
      const t = primaryTag(c);
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t).push(c);
    }
    // Order tags by PRIMARY_TAGS order
    const tagOrder = [...PRIMARY_TAGS, 'other'].filter((t) => byTag.has(t));

    for (const tag of tagOrder) {
      const items = byTag.get(tag).sort((a, b) => a.slug.localeCompare(b.slug));
      out.push(`### ${tag.charAt(0).toUpperCase()}${tag.slice(1)}  *(${items.length})*`);
      out.push('');
      out.push('| Slug | Description |');
      out.push('|---|---|');
      for (const c of items) {
        const slugCell = `[\`${c.slug}\`](https://github.com/opensip-ai/opensip-tools/blob/main/${c.file})`;
        const descCell = escapeMd(c.description ?? '*(no description; see source)*');
        out.push(`| ${slugCell} | ${descCell} |`);
      }
      out.push('');
    }
  }

  out.push('---');
  out.push('');
  out.push('## How to use a check');
  out.push('');
  out.push('Every check above is loaded automatically when its pack is in your project\'s `node_modules/`. To target one explicitly:');
  out.push('');
  out.push('```bash');
  out.push('opensip-tools fit --check <slug>           # run one check');
  out.push('opensip-tools fit --tags security          # run all checks tagged security');
  out.push('opensip-tools fit --recipe quick-smoke     # run a named lineup');
  out.push('```');
  out.push('');
  out.push('Per-check parameter overrides go in your recipe under `config:` — see [recipes and checks](../20-fit/01-recipes-and-checks.md).');
  out.push('');
  out.push('To write your own check, see [plugin authoring](../50-extend/01-plugin-authoring.md).');

  process.stdout.write(out.join('\n') + '\n');
}

main().catch((e) => {
  process.stderr.write(`error: ${e.message}\n`);
  process.exit(1);
});
