// @fitness-ignore-file performance-anti-patterns -- spread in CLI report aggregation iterates bounded result sets (rule counts, entry-point lists).
// @fitness-ignore-file public-api-jsdoc -- helper barrel for the graph CLI report; the report payload types are documented via their consumers (graph.ts) and the engine's public types module.
/**
 * @fileoverview Unified human-readable graph report.
 *
 * Extracted from `cli/graph.ts` so the orchestrator there stays focused
 * on dispatch (json/sarif/catalog-json/packages/report/gate/cloud-report).
 *
 * Owns the catalog-summary, findings-by-rule, entry-points, and summary
 * sections — both as a `string[]` builder (consumed by the Ink view via
 * `buildUnifiedReportLines`) and as a direct stdout writer
 * (`writeUnifiedReport`, used by non-interactive paths).
 */

import { inferEntryPoints } from '../rules/_entry-points.js';
import { currentRules } from '../rules/registry.js';

import type { EntryPoint } from '../rules/_entry-points.js';
import type { Catalog, Indexes } from '../types.js';
import type { Signal } from '@opensip-tools/core';

const ENTRY_POINTS_PREVIEW = 10;
const FINDINGS_PREVIEW = 10;

export interface UnifiedReportInput {
  readonly catalog: Catalog | null;
  readonly indexes: Indexes | null;
  readonly signals: readonly Signal[];
  readonly cacheHit: boolean;
}

function countFiles(catalog: Catalog): number {
  const files = new Set<string>();
  for (const name of Object.keys(catalog.functions)) {
    const occs = catalog.functions[name];
    if (!occs) continue;
    for (const o of occs) files.add(o.filePath);
  }
  return files.size;
}

function countOccurrences(catalog: Catalog): number {
  let n = 0;
  for (const name of Object.keys(catalog.functions)) {
    const occs = catalog.functions[name];
    if (occs) n += occs.length;
  }
  return n;
}

/**
 * Build the unified terminal report lines: catalog summary, findings
 * grouped by rule, top-N entry points, and a single-line summary. The
 * caller decides where to write them (raw stdout for non-interactive
 * paths, or the Ink view in the default human-report path).
 */
export function buildUnifiedReportLines(input: UnifiedReportInput): readonly string[] {
  const knownRuleIds = currentRules().map((r) => r.slug);
  const byRule = groupSignalsByRule(input.signals);
  const eps = input.catalog && input.indexes
    ? enrichEntryPoints(input.catalog, input.indexes)
    : [];

  return [
    ...renderCatalogSection(input.catalog, input.cacheHit),
    '',
    ...renderFindingsSection(input.signals.length, byRule, knownRuleIds),
    ...renderEntryPointsSection(eps),
    '',
    ...renderSummarySection(byRule, knownRuleIds, input.signals.length),
  ];
}

export function writeUnifiedReport(input: UnifiedReportInput): void {
  const lines = ['opensip-tools graph', '', ...buildUnifiedReportLines(input)];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function renderCatalogSection(catalog: Catalog | null, cacheHit: boolean): readonly string[] {
  const lines: string[] = ['== Catalog =='];
  if (catalog) {
    const fileCount = countFiles(catalog);
    const fnCount = countOccurrences(catalog);
    lines.push(
      `${String(fnCount)} functions across ${String(fileCount)} files (cacheHit=${String(cacheHit)})`,
    );
  } else {
    /* v8 ignore next */
    lines.push('(no catalog produced)');
  }
  return lines;
}

function renderFindingsSection(
  totalSignals: number,
  byRule: ReadonlyMap<string, readonly Signal[]>,
  knownRuleIds: readonly string[],
): readonly string[] {
  const lines: string[] = [`== Findings (${String(totalSignals)}) ==`];
  for (const ruleId of knownRuleIds) {
    lines.push(...renderRuleBlock(ruleId, byRule.get(ruleId) ?? []));
  }
  return lines;
}

function renderRuleBlock(ruleId: string, findings: readonly Signal[]): readonly string[] {
  const header = `[${ruleId}] ${String(findings.length)} finding(s)`;
  const preview = findings.slice(0, FINDINGS_PREVIEW).map((f) => {
    const loc = f.line ? `:${String(f.line)}` : '';
    return `  ${f.filePath}${loc} — ${f.message}`;
  });
  const overflow = findings.length > preview.length
    /* v8 ignore next */
    ? [`  ... ${String(findings.length - preview.length)} more (use --json for full list)`]
    : [];
  return [header, ...preview, ...overflow, ''];
}

function renderEntryPointsSection(eps: readonly EnrichedEntryPoint[]): readonly string[] {
  const header = `== Entry points (${String(eps.length)}) ==`;
  if (eps.length === 0) return [header, '(none inferred)'];
  const top = [...eps].sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName)).slice(0, ENTRY_POINTS_PREVIEW);
  const intro = `Top ${String(top.length)} (use --json for full list):`;
  const items = top.map((ep) => `  [${ep.reason}] ${ep.qualifiedName}`);
  return [header, intro, ...items];
}

function renderSummarySection(
  byRule: ReadonlyMap<string, readonly Signal[]>,
  knownRuleIds: readonly string[],
  totalSignals: number,
): readonly string[] {
  const stats = summarizeRules(byRule, knownRuleIds);
  return [
    '== Summary ==',
    `${String(stats.clean)} rule(s) clean, ${String(stats.dirty)} with findings (${String(totalSignals)} total).`,
    'Run `opensip-tools dashboard` for the interactive Code Paths view.',
  ];
}

interface EnrichedEntryPoint {
  readonly reason: EntryPoint['reason'];
  readonly qualifiedName: string;
  readonly filePath: string;
  readonly line: number;
}

function enrichEntryPoints(catalog: Catalog, indexes: Indexes): readonly EnrichedEntryPoint[] {
  const eps = inferEntryPoints(catalog, indexes);
  const out: EnrichedEntryPoint[] = [];
  for (const ep of eps) {
    const occ = indexes.byBodyHash.get(ep.bodyHash);
    if (!occ) continue;
    out.push({
      reason: ep.reason,
      qualifiedName: occ.qualifiedName,
      filePath: occ.filePath,
      line: occ.line,
    });
  }
  return out;
}

function groupSignalsByRule(signals: readonly Signal[]): ReadonlyMap<string, readonly Signal[]> {
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

function summarizeRules(
  byRule: ReadonlyMap<string, readonly Signal[]>,
  knownRuleIds: readonly string[],
): { readonly clean: number; readonly dirty: number } {
  let clean = 0;
  let dirty = 0;
  for (const ruleId of knownRuleIds) {
    const findings = byRule.get(ruleId) ?? [];
    if (findings.length === 0) clean += 1;
    else dirty += 1;
  }
  return { clean, dirty };
}
