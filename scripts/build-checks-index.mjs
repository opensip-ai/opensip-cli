#!/usr/bin/env node
//
// Generate docs/public/70-reference/05-checks-index.md from the
// metadata extracted by scripts/extract-checks-metadata.mjs.
//
// Why a generator rather than a hand-curated index: the checks corpus, with
// descriptions and tags, is too much to keep in sync by hand. The corpus
// changes every time a new check ships; a generated index keeps the
// docs honest about what's actually in the box. This script is the
// authoritative writer of docs/public/70-reference/05-checks-index.md
// — do not hand-edit that file; edit this generator instead.
//
// Usage:
//   node scripts/extract-checks-metadata.mjs > /tmp/checks.json
//   node scripts/build-checks-index.mjs /tmp/checks.json > docs/public/70-reference/05-checks-index.md
//
// Or piped:
//   node scripts/extract-checks-metadata.mjs | node scripts/build-checks-index.mjs - > <output>
//

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INDEX_DOC = join(REPO_ROOT, 'docs/public/70-reference/05-checks-index.md');

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
  return s.replaceAll('|', String.raw`\|`).replaceAll('\n', ' ').trim();
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
  const args = process.argv.slice(2);
  const checkMode = args.includes('--check');
  const inputArg = args.find((a) => a !== '--check');
  const raw = await readInput(inputArg);
  const checks = JSON.parse(raw);
  const total = checks.length;

  const today = new Date().toISOString().slice(0, 10);

  // Derive the release line from the published version (the `MAJOR.MINOR.x`
  // train) rather than hard-coding it, so it never goes stale on a bump.
  const corePkg = JSON.parse(await fs.readFile(join(REPO_ROOT, 'packages/core/package.json'), 'utf8'));
  const [maj, min] = String(corePkg.version).split('.');
  const releaseLine = `release: v${maj}.${min}.x`;

  const out = [ '---', 'status: current', `last_verified: ${today}`, releaseLine, 'title: "Checks reference"', 'audience: [getting-started, ci-integrators, plugin-authors]', 'purpose: "Browsable index of every built-in fit check, grouped by pack and primary tag. Auto-generated from source by scripts/build-checks-index.mjs."', 'source-files:', '  - packages/fitness/checks-universal/src/checks/', '  - packages/fitness/checks-typescript/src/checks/', '  - packages/fitness/checks-python/src/checks/', '  - packages/fitness/checks-go/src/checks/', '  - packages/fitness/checks-java/src/checks/', '  - packages/fitness/checks-cpp/src/checks/', '  - packages/fitness/checks-rust/src/checks/', 'related-docs:', '  - ../00-start/02-show-me-the-loops.md', '  - ../50-extend/01-plugin-authoring.md', '  - ../50-extend/04-check-pack-architecture.md', '---', '# Checks reference', '', `opensip-tools ships **${total}+ built-in checks** across seven packs. Each check is a single source file that returns violations when the rule is broken. Below: every check by pack, grouped by primary tag, with the one-line description from \`defineCheck\`.`, '', '> This page is **auto-generated** from the source by [`scripts/build-checks-index.mjs`](https://github.com/opensip-ai/opensip-tools/blob/main/scripts/build-checks-index.mjs). Do not edit it by hand — edit the check\'s source file (the link in each row), then re-run the generator.', ''];

  // Per-pack section
  for (const pack of PACK_ORDER) {
    const inPack = checks.filter((c) => c.pack === pack);
    if (inPack.length === 0) continue;
    const display = PACK_DISPLAY[pack];
    out.push(
      '---', '',
      `## ${display.title}  *(${inPack.length} ${checkLabel(inPack.length)})*`, '', display.scope, '',
    );

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
      out.push(`### ${tag.charAt(0).toUpperCase()}${tag.slice(1)}  *(${items.length})*`, '', '| Slug | Description |', '|---|---|');
      for (const c of items) {
        const slugCell = `[\`${c.slug}\`](https://github.com/opensip-ai/opensip-tools/blob/main/${c.file})`;
        const descCell = escapeMd(c.description ?? '*(no description; see source)*');
        out.push(`| ${slugCell} | ${descCell} |`);
      }
      out.push('');
    }
  }

  out.push('---', '', '## How to use a check', '', 'Every check above is loaded automatically when its pack is in your project\'s `node_modules/`. To target one explicitly:', '', '```bash', 'opensip-tools fit --check <slug>           # run one check', 'opensip-tools fit --tags security          # run all checks tagged security', 'opensip-tools fit --recipe quick-smoke     # run a named lineup', '```', '', 'Per-check parameter overrides go in your recipe under `config:` — see [recipes and checks](../20-fit/01-recipes-and-checks.md).', '', 'To write your own check, see [plugin authoring](../50-extend/01-plugin-authoring.md).');

  const generated = out.join('\n') + '\n';

  if (checkMode) {
    // The `last_verified` stamp is intentionally volatile (today's date),
    // so normalise it out before comparing — only real corpus drift
    // should fail the gate.
    const normalize = (s) => s.replace(/^last_verified:.*$/m, 'last_verified: <stamp>');
    let committed;
    try {
      committed = await fs.readFile(INDEX_DOC, 'utf8');
    } catch {
      process.stderr.write(
        `error: ${INDEX_DOC} not found. Run \`pnpm docs:checks-index\` to generate it.\n`,
      );
      process.exit(1);
    }
    if (normalize(generated) !== normalize(committed)) {
      process.stderr.write(
        'error: docs/public/70-reference/05-checks-index.md is stale relative to the checks corpus.\n' +
          '       Run `pnpm docs:checks-index` and commit the regenerated file.\n',
      );
      process.exit(1);
    }
    return;
  }

  process.stdout.write(generated);
}

main().catch((error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exit(1);
});
