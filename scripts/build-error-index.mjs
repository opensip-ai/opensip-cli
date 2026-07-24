#!/usr/bin/env node
/**
 * Generate docs/public/70-reference/18-error-code-index.md from extract-error-catalog-metadata.mjs JSON.
 *
 * Usage:
 *   node scripts/extract-error-catalog-metadata.mjs | node scripts/build-error-index.mjs - > docs/public/70-reference/18-error-code-index.md
 *   node scripts/extract-error-catalog-metadata.mjs | node scripts/build-error-index.mjs - --check
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INDEX_DOC = join(REPO_ROOT, 'docs/public/70-reference/18-error-code-index.md');

function escapeMd(s) {
  if (!s) return '';
  return s.replaceAll('|', String.raw`\|`).replaceAll('\n', ' ').trim();
}

function buildMarkdown(payload) {
  const lines = [];
  lines.push('---');
  lines.push('status: current');
  lines.push(`last_verified: ${new Date().toISOString().slice(0, 10)}`);
  lines.push('release: v0.8.4');
  lines.push('title: "Error code index"');
  lines.push('audience: [contributors, operators, agents]');
  lines.push(
    'purpose: "Generated registry of registered OpenSIP error codes with axes and operator actions."',
  );
  lines.push('generated: true');
  lines.push('---');
  lines.push('');
  lines.push('# Error code index');
  lines.push('');
  lines.push(
    '> **Generated.** Do not hand-edit. Run `pnpm docs:error-index` after catalog changes. This lists **registered** definitions only; the set grows as packages register catalogs.',
  );
  lines.push('');
  lines.push(`- Catalog sources: **${payload.catalogCount}**`);
  lines.push(`- Definitions: **${payload.definitionCount}**`);
  lines.push('');
  lines.push('## Catalogs');
  lines.push('');
  lines.push('| Package | Owner id | Source file | Count |');
  lines.push('|---|---|---|---:|');
  for (const c of payload.catalogs ?? []) {
    lines.push(
      `| \`${escapeMd(c.packageName)}\` | \`${escapeMd(c.ownerId)}\` | \`${escapeMd(c.file)}\` | ${c.definitionCount} |`,
    );
  }
  lines.push('');
  lines.push('## Codes');
  lines.push('');
  lines.push(
    '| Code | Package | Source | Responsibility | Kind | Retry | Severity | Exit | Lifecycle | Operator action |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const d of payload.definitions ?? []) {
    lines.push(
      `| \`${escapeMd(d.code)}\` | \`${escapeMd(d.packageName)}\` | ${escapeMd(d.source)} | ${escapeMd(d.defaultResponsibility)} | ${escapeMd(d.kind)} | ${escapeMd(d.retry)} | ${escapeMd(d.severity)} | ${escapeMd(d.exitClass)} | ${escapeMd(d.lifecycle)} | ${escapeMd(d.operatorAction)} |`,
    );
  }
  lines.push('');
  lines.push('## See also');
  lines.push('');
  lines.push(
    '- [Error and resiliency model](../80-implementation/09-error-and-resiliency-model.md)',
  );
  lines.push(
    '- [ADR-0181 structured error definitions](../../decisions/ADR-0181-structured-error-definitions-and-failure-envelope.md)',
  );
  lines.push('');
  return `${lines.join('\n')}`;
}

async function readPayload(arg) {
  if (arg === '-' || arg === undefined) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
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
    let existing = '';
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
      console.error('docs/public/70-reference/18-error-code-index.md is stale; run pnpm docs:error-index');
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
