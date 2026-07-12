/**
 * Assert every audit prompt embeds one synchronized required graph-first
 * workflow (Phase 9 Task 9.5). Headings are derived from the document tables
 * rather than a second hand-maintained numeric list.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROMPTS = join(ROOT, 'docs', 'ai-helpers', 'prompts.md');

/** Tokens every Required Graph-First Workflow block must contain. */
const REQUIRED_TOKENS = [
  'pnpm graph',
  'get_agent_catalog',
  'get_architecture',
  'inventory / evidence / grouping / projection',
  'search_declarations',
  'references_to',
  'search_symbols',
  'get_runtime_wiring',
  'w1:',
  'g1:',
  'runtime edges, not',
  'Never refresh merely because step 1 completed',
  'returned cursor',
  'hard-cap',
];

function extractAuditPromptHeadings(markdown) {
  // Prefer the "Audit prompts:" table rows: | Prompt N: Name | ...
  const tableHeadings = [];
  const tableRe = /^\|\s*(Prompt\s+\d+:\s*[^|]+?)\s*\|/gm;
  for (const match of markdown.matchAll(tableRe)) {
    const title = match[1].trim();
    if (/^Prompt\s+\d+:/i.test(title)) tableHeadings.push(title);
  }
  if (tableHeadings.length > 0) return tableHeadings;

  // Fallback: ## Prompt N: ... headings that contain a Required Graph-First block.
  const headings = [];
  for (const match of markdown.matchAll(/^## (Prompt\s+\d+:[^\n]+)$/gm)) {
    headings.push(match[1].trim());
  }
  return headings;
}

function sectionForHeading(markdown, heading) {
  const start = markdown.indexOf(`## ${heading}`);
  if (start < 0) return null;
  const rest = markdown.slice(start + 3);
  const next = rest.search(/\n## /);
  return next < 0 ? markdown.slice(start) : markdown.slice(start, start + 3 + next);
}

describe('audit prompts graph-first workflow', () => {
  it('synchronizes the required workflow across every audit prompt section', () => {
    const markdown = readFileSync(PROMPTS, 'utf8');
    const headings = extractAuditPromptHeadings(markdown);
    assert.ok(headings.length >= 8, `expected audit prompt table rows, got ${headings.length}`);

    const workflows = [];
    for (const heading of headings) {
      // Prompt 2/3/4/14 etc. may appear in TOC but not all are audit prompts with
      // the block; only assert headings that include a Required Graph-First section.
      const section = sectionForHeading(markdown, heading);
      if (section === null) {
        // Table title may not equal the ## heading exactly — fuzzy match.
        const fuzzy = markdown.match(new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'));
        assert.ok(fuzzy, `missing section heading for table row: ${heading}`);
        continue;
      }
      if (!section.includes('### Required Graph-First Workflow')) continue;
      const start = section.indexOf('### Required Graph-First Workflow');
      const after = section.slice(start);
      const endRel = after.search(/\n### /);
      // Second ### after the workflow title ends the block when endRel points past title
      const end = endRel > 0 ? start + endRel : section.length;
      // Actually first match is the title itself; find next ### after title line
      const bodyStart = section.indexOf('\n', start) + 1;
      const nextH3 = section.indexOf('\n### ', bodyStart);
      const block = section.slice(start, nextH3 < 0 ? section.length : nextH3);
      workflows.push({ heading, block });
    }

    assert.ok(
      workflows.length >= 8,
      `expected ≥8 audit prompts with graph-first blocks, got ${workflows.length}`,
    );

    const normalized = workflows.map((w) => w.block.replace(/\s+/g, ' ').trim());
    const first = normalized[0];
    for (let i = 1; i < normalized.length; i++) {
      assert.equal(
        normalized[i],
        first,
        `workflow drift between "${workflows[0].heading}" and "${workflows[i].heading}"`,
      );
    }

    for (const token of REQUIRED_TOKENS) {
      assert.ok(first.includes(token.replace(/\s+/g, ' ')) || workflows[0].block.includes(token),
        `missing required token: ${token}`);
    }

    // Explicit negatives
    assert.ok(!markdown.includes('19 tools'));
    assert.ok(!markdown.includes('20 tools'));
    assert.ok(!/flat coverage/i.test(markdown));

    // Prompt 5 dual output
    const p5 = sectionForHeading(markdown, 'Prompt 5: Modular Architecture Audit');
    assert.ok(p5, 'Prompt 5 section');
    assert.ok(p5.includes('MCP evidence-surface assessment'));
    assert.ok(p5.includes('four facets') || p5.includes('four coverage facets'));
  });
});
