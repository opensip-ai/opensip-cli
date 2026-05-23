/**
 * Table renderer — pure-text table for terminal output.
 *
 * Per PR-3 / DEC-8: a switch in the CLI handler dispatches to this
 * renderer; no Map-keyed registry. Each renderer is `(signals, ctx)
 * → string`.
 */

import type { Renderer } from './types.js';
import type { Signal } from '@opensip-tools/core';

export const renderTable: Renderer = (signals, _context): string => {
  if (signals.length === 0) {
    return 'graph: no findings.\n';
  }
  // Group by ruleId for readability.
  const byRule = groupByRule(signals);
  const sortedRules = [...byRule.keys()].sort();
  const lines = [`graph: ${String(signals.length)} finding(s).`];
  for (const ruleId of sortedRules) {
    /* v8 ignore next */
    const findings = byRule.get(ruleId) ?? [];
    lines.push('', `[${ruleId}] ${String(findings.length)} finding(s)`);
    for (const f of findings) {
      const loc = f.line ? `:${String(f.line)}` : '';
      lines.push(`  ${f.filePath}${loc} — ${f.message}`);
    }
  }
  return `${lines.join('\n')}\n`;
};

function groupByRule(signals: readonly Signal[]): ReadonlyMap<string, readonly Signal[]> {
  const out = new Map<string, Signal[]>();
  for (const s of signals) {
    let arr = out.get(s.ruleId);
    if (!arr) {
      arr = [];
      out.set(s.ruleId, arr);
    }
    arr.push(s);
  }
  return out;
}
