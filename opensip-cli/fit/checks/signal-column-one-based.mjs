/**
 * @fileoverview signal-column-one-based — forbid raw `match.index` as a Signal /
 *               CheckViolation column (ADR-0179). Project-local SELF-check.
 *
 * Lives here (not in shipped packs) because it encodes opensip-cli' signal
 * construction contract: columns on Signal are 1-based at `createSignal`, and
 * regex emitters must convert `match.index` (0-based) with `+ 1`. A consumer
 * repo does not share that construction gate, so the rule is opensip-internal.
 *
 * WHY: `String.prototype.match` / `RegExp.exec` return 0-based `index`. Passing
 * it straight into `column:` made SARIF / reports / MCP point at the wrong
 * character (off by one). `signal-sarif`'s `atLeastOne` only dropped zeros; it
 * did not correct non-zero 0-based columns.
 *
 * Detects `column: match.index` (and optional chaining / whitespace variants)
 * when not immediately followed by `+ 1` / `+1`. Confidence: high.
 */
import { defineCheck, isTestFile } from '@opensip-cli/fitness';

/** `column: match.index` without a following `+ 1` (1-based conversion). */
const RAW_MATCH_INDEX_COLUMN_RE = /\bcolumn\s*:\s*match\.index\b(?!\s*\+\s*1\b)/g;

const FILE_IGNORE_RE = /@fitness-ignore-file\s+signal-column-one-based/;

/** Pure analysis. Exported for direct exercise if a harness is added later. */
export function analyzeSignalColumnOneBased(content, filePath) {
  if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx') && !filePath.endsWith('.mjs')) {
    return [];
  }
  if (filePath.endsWith('.d.ts')) return [];
  if (isTestFile(filePath)) return [];

  const normalized = filePath.replaceAll('\\', '/');
  // Emitter surface: fitness packs + frameworks that stamp violation columns.
  if (
    !normalized.includes('/packages/fitness/') &&
    !normalized.includes('/packages/graph/') &&
    !normalized.includes('/packages/yagni/') &&
    !normalized.includes('/packages/simulation/') &&
    !normalized.includes('/packages/tool-') &&
    !normalized.includes('/packages/languages/') &&
    !normalized.includes('/opensip-cli/fit/checks/')
  ) {
    return [];
  }

  if (!content.includes('match.index')) return [];
  const rawLines = content.split('\n');
  if (rawLines.slice(0, 50).some((line) => FILE_IGNORE_RE.test(line))) return [];

  const violations = [];
  for (const match of content.matchAll(RAW_MATCH_INDEX_COLUMN_RE)) {
    const idx = match.index ?? 0;
    const line = content.slice(0, idx).split('\n').length;
    violations.push({
      line,
      severity: 'error',
      message:
        'Raw `match.index` used as a column (0-based). Signal columns are 1-based ' +
        '(ADR-0179); use `match.index + 1` so SARIF/report/MCP point at the right character.',
      suggestion: 'Write `column: match.index + 1` (or omit column for whole-line findings).',
      type: 'signal-column-one-based',
    });
  }
  return violations;
}

export const checks = [
  defineCheck({
    id: 'c8e4a1f2-9b3d-4e7a-a5c1-0d6f8e2b4a19',
    slug: 'signal-column-one-based',
    description:
      'Signal/violation columns must be 1-based (ADR-0179); forbid raw match.index as column',
    scope: { languages: ['typescript'], concerns: ['backend'] },
    tags: ['architecture'],
    fileTypes: ['ts', 'mjs'],
    contentFilter: 'strip-strings-and-comments',
    analyze: (content, filePath) => analyzeSignalColumnOneBased(content, filePath),
  }),
];
