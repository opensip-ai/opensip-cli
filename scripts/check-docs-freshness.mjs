#!/usr/bin/env node
/**
 * check-docs-freshness — CI gate for two classes of docs/public rot that the
 * 2026-06-11 audits showed slip through review:
 *
 *   1. RETIRED TERMS. When an ADR deletes or renames a runtime concept (a
 *      table, a repo class, a hook), prose citing the old name keeps reading
 *      as *current* documentation. Each retired term below carries the hint
 *      for what replaced it. A term may legitimately appear as migration
 *      history — those mentions are pinned in ALLOW (file + term), so a NEW
 *      mention anywhere else fails the build.
 *
 *   2. DEAD SOURCE REFERENCES. Doc frontmatter `source-files:` entries and
 *      inline repo-relative links (`../../../packages/...`) must point at
 *      files that exist. `build-web-docs.mjs` rewrites these links to pinned
 *      GitHub URLs, so a dead path ships as a 404 on the website.
 *
 * Scope: docs/public/ only — docs/web-generated/ is generated from it and
 * covered by `docs:check`; docs/decisions/ is append-only history where
 * retired names are the point.
 *
 * Adding a sanctioned historical mention: append {file, term} to ALLOW with
 * the term spelled exactly as the RETIRED_TERMS pattern name.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_ROOT = join(ROOT, 'docs', 'public');

/** Retired runtime concepts. `name` doubles as the ALLOW key. */
const RETIRED_TERMS = [
  {
    name: 'fit_baseline',
    re: /\bfit_baseline\b/,
    hint: "tool_baseline_entries (tool = 'fitness'), ADR-0036",
  },
  {
    name: 'graph_baseline_signals',
    re: /\bgraph_baseline_signals\b/,
    hint: "tool_baseline_entries (tool = 'graph'), ADR-0036",
  },
  {
    name: 'graph_baseline_meta',
    re: /\bgraph_baseline_meta\b/,
    hint: 'tool_baseline_meta (scoped by tool), ADR-0036',
  },
  {
    name: 'FitBaselineRepo',
    re: /\bFitBaselineRepo\b/,
    hint: 'the generic BaselineRepo in @opensip-cli/datastore, ADR-0036',
  },
  {
    name: 'GraphBaselineRepo',
    re: /\bGraphBaselineRepo\b/,
    hint: 'the generic BaselineRepo in @opensip-cli/datastore, ADR-0036',
  },
  {
    name: 'compareToBaseline',
    re: /\bcompareToBaseline\b/,
    hint: 'cli.compareBaseline + the pure diffBaseline in @opensip-cli/output',
  },
  {
    name: 'extractViolationsFromEnvelope',
    re: /\bextractViolationsFrom(Envelope|StoredBaseline)\b/,
    hint: 'per-tool Tool.fingerprintStrategy (ADR-0036)',
  },
  // `narratedRemoval: true` — pages across the docs legitimately tell this
  // term's removal story in place ("the pre-GA register(cli) hook was
  // removed"); a line that names the removal is history, not rot.
  {
    name: 'Tool.register',
    re: /\bTool\.register\b|\bregister\(cli\)/,
    narratedRemoval: true,
    hint: 'declarative commandSpecs (launch; the raw-Commander hook is gone)',
  },
  {
    name: 'shouldFail',
    re: /\bshouldFail\b/,
    hint: 'envelope.verdict — the host derives the exit code (ADR-0035)',
  },
  {
    name: 'defaultToolRegistry',
    re: /\bdefault(Tool|Language)Registry\b/,
    hint: 'per-run registries constructed by the bootstrap and carried on RunScope',
  },
  {
    name: 'CliOutput',
    re: /\bCliOutput\b/,
    narratedRemoval: true,
    hint: 'SignalEnvelope (schemaVersion 2, ADR-0011)',
  },
  {
    name: 'gate-save exits 0',
    re: /exits? 0 regardless/,
    hint: '--gate-save exits per failOnErrors/failOnWarnings (ADR-0020)',
  },
];

/** Sanctioned historical mentions: the term is discussed AS history. */
const ALLOW = [
  { file: '80-implementation/03-session-and-persistence.md', term: 'fit_baseline' },
  { file: '80-implementation/03-session-and-persistence.md', term: 'graph_baseline_signals' },
  { file: '80-implementation/03-session-and-persistence.md', term: 'graph_baseline_meta' },
  { file: '80-implementation/01-cli-dispatch.md', term: 'defaultToolRegistry' },
];

function isAllowed(relFile, termName) {
  return ALLOW.some((a) => a.file === relFile && a.term === termName);
}

/** A line that names the term's removal/replacement is history, not rot. */
const REMOVAL_NARRATION = /\b(removed|gone|retired|deleted|replaced|pre-GA|husk|old)\b/i;

function* walkMarkdown(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMarkdown(abs);
    else if (entry.name.endsWith('.md')) yield abs;
  }
}

const failures = [];

for (const absFile of walkMarkdown(DOCS_ROOT)) {
  const relFile = relative(DOCS_ROOT, absFile);
  const text = readFileSync(absFile, 'utf8');
  const lines = text.split('\n');

  // 1) Retired terms.
  for (const [i, line] of lines.entries()) {
    for (const t of RETIRED_TERMS) {
      if (t.narratedRemoval === true && REMOVAL_NARRATION.test(line)) continue;
      if (t.re.test(line) && !isAllowed(relFile, t.name)) {
        failures.push(
          `docs/public/${relFile}:${String(i + 1)} cites retired '${t.name}' — current: ${t.hint}\n    ${line.trim().slice(0, 160)}`,
        );
      }
    }
  }

  // 2a) Frontmatter source-files must exist (file or directory).
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const sf = fm[1].match(/source-files:\n((?:\s+-\s+.+\n)+)/);
    if (sf) {
      for (const m of sf[1].matchAll(/-\s+(\S+)/g)) {
        if (m[1].includes('*')) continue; // glob entries describe a family, not one file
        const target = join(ROOT, m[1]);
        if (!existsSync(target)) {
          failures.push(`docs/public/${relFile}: frontmatter source-file does not exist: ${m[1]}`);
        }
      }
    }
  }

  // 2b) Inline relative links that resolve outside docs/public must exist.
  //     (Sibling .md links inside docs/public are the website's own routing,
  //     validated by build-web-docs; repo links become pinned GitHub URLs.)
  for (const m of text.matchAll(/\]\(((?:\.\.\/)+[^)#?\s]+)(?:#[^)\s]*)?\)/g)) {
    const target = resolve(dirname(absFile), m[1]);
    if (!target.startsWith(DOCS_ROOT) && target.startsWith(ROOT) && !existsSync(target)) {
      failures.push(`docs/public/${relFile}: dead repo link: ${m[1]}`);
    }
  }
}

// An ALLOW entry whose file no longer contains the term is stale bookkeeping.
for (const a of ALLOW) {
  const abs = join(DOCS_ROOT, a.file);
  const term = RETIRED_TERMS.find((t) => t.name === a.term);
  if (!existsSync(abs) || !term || !term.re.test(readFileSync(abs, 'utf8'))) {
    failures.push(
      `check-docs-freshness ALLOW entry is stale (file/term no longer matches): ${a.file} / ${a.term}`,
    );
  }
}

if (failures.length > 0) {
  console.error(`check-docs-freshness: ${String(failures.length)} failure(s)\n`);
  for (const f of failures) console.error(`  ${f}\n`);
  console.error(
    'Fix the doc to describe the CURRENT runtime (see each hint), or — only for genuine migration-history prose — add an ALLOW entry in scripts/check-docs-freshness.mjs.',
  );
  process.exit(1);
}

console.log(
  'check-docs-freshness: OK — no retired terms outside sanctioned history, no dead source references.',
);
