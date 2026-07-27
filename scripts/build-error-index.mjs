#!/usr/bin/env node
/**
 * Generate docs/public/70-reference/18-error-code-index.md from extract-error-catalog-metadata.mjs JSON.
 *
 * Usage:
 *   node scripts/extract-error-catalog-metadata.mjs | node scripts/build-error-index.mjs - > docs/public/70-reference/18-error-code-index.md
 *   node scripts/extract-error-catalog-metadata.mjs | node scripts/build-error-index.mjs - --check
 */

import { promises as fs, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/**
 * The version this doc is generated against, read rather than hardcoded.
 *
 * It was a literal `v0.8.4`, so every regeneration re-asserted a stale release and the
 * version-surface gate drifted the moment core moved on — a generated file cannot be the thing
 * that goes out of date.
 */
function coreVersion() {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'packages/core/package.json'), 'utf8')).version;
}

const INDEX_DOC = join(REPO_ROOT, 'docs/public/70-reference/18-error-code-index.md');

function escapeMd(s) {
  if (!s) return '';
  return s
    .replaceAll('|', String.raw`\|`)
    .replaceAll('\n', ' ')
    .trim();
}

function buildMarkdown(payload) {
  const catalogRows = (payload.catalogs ?? []).map(
    (c) =>
      `| \`${escapeMd(c.packageName)}\` | \`${escapeMd(c.ownerId)}\` | \`${escapeMd(c.file)}\` | ${c.definitionCount} |`,
  );
  const codeRows = (payload.definitions ?? []).map(
    (d) =>
      `| \`${escapeMd(d.code)}\` | \`${escapeMd(d.packageName)}\` | ${escapeMd(d.source)} | ${escapeMd(d.defaultResponsibility)} | ${escapeMd(d.kind)} | ${escapeMd(d.retry)} | ${escapeMd(d.severity)} | ${escapeMd(d.exitClass)} | ${escapeMd(d.lifecycle)} | ${escapeMd(d.operatorAction)} |`,
  );
  return [
    '---',
    'status: current',
    `last_verified: ${new Date().toISOString().slice(0, 10)}`,
    `release: v${coreVersion()}`,
    'title: "Error code index"',
    'audience: [contributors, operators, agents]',
    'purpose: "Generated registry of registered OpenSIP error codes with axes and operator actions."',
    'generated: true',
    '---',
    '',
    '# Error code index',
    '',
    '> **Generated.** Do not hand-edit. Run `pnpm docs:error-index` after catalog changes. This lists **registered** definitions only; the set grows as packages register catalogs.',
    '',
    `- Catalog sources: **${payload.catalogCount}**`,
    `- Definitions: **${payload.definitionCount}**`,
    '',
    '## Catalogs',
    '',
    '| Package | Owner id | Source file | Count |',
    '|---|---|---|---:|',
    ...catalogRows,
    '',
    '## Codes',
    '',
    '| Code | Package | Source | Responsibility | Kind | Retry | Severity | Exit | Lifecycle | Operator action |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...codeRows,
    '',
    '## See also',
    '',
    '- [Error and resiliency model](../80-implementation/09-error-and-resiliency-model.md)',
    '- [ADR-0181 structured error definitions](../../decisions/ADR-0181-structured-error-definitions-and-failure-envelope.md)',
    '',
  ].join('\n');
}

async function readPayload(arg) {
  if (arg === '-' || arg === undefined) {
    const chunks = await Array.fromAsync(process.stdin);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  return JSON.parse(await fs.readFile(arg, 'utf8'));
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const input = args.find((a) => a !== '--check') ?? '-';
  const payload = await readPayload(input);
  const markdown = buildMarkdown(payload);

  if (check) {
    let existing;
    try {
      existing = await fs.readFile(INDEX_DOC, 'utf8');
    } catch {
      console.error(`missing ${INDEX_DOC}; run pnpm docs:error-index`);
      process.exitCode = 1;
      return;
    }
    // Normalize generated timestamp line for check
    const norm = (s) => s.replace(/^last_verified:.*$/mu, 'last_verified: <date>');
    if (norm(existing) !== norm(markdown)) {
      console.error(
        'docs/public/70-reference/18-error-code-index.md is stale; run pnpm docs:error-index',
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write('error-code-index: ok\n');
    return;
  }

  process.stdout.write(markdown);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
