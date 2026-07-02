#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  renderBudgetTable,
  renderTierTable,
  replaceMarkedSection,
} from './perf/render-slo-markdown.mjs';
import { loadSloConfig } from './perf/slo-config.mjs';

const DOC_PATH = resolve('docs/public/70-reference/11-performance-slos.md');

export async function buildPerformanceSloDoc(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const config = await loadSloConfig();
  const original = await readFile(DOC_PATH, 'utf8');
  let next = replaceMarkedSection(original, 'performance-slo-tiers', renderTierTable(config));
  next = replaceMarkedSection(next, 'performance-slo-budgets', renderBudgetTable(config));

  if (check) {
    if (next !== original) {
      throw new Error('Performance SLO docs are stale. Run `pnpm docs:performance-slos`.');
    }
    return { changed: false };
  }
  await writeFile(DOC_PATH, next);
  return { changed: next !== original };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildPerformanceSloDoc().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
