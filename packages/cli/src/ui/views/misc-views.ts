/**
 * View-model builders for the remaining result types: list-checks,
 * list-recipes, history, simulation notice, report, help, and the
 * clear/configure/uninstall "done" summaries. Each reproduces the visible
 * output of its retired Ink component as a renderer-agnostic ViewNode.
 */

import {
  line,
  group,
  viewTable,
  type Span,
  type TableColumnSpec,
  type Tone,
  type ViewNode,
} from '@opensip-cli/cli-ui';

import { formatBytes } from '../../format-bytes.js';

import type {
  ClearDoneResult,
  ConfigureDoneResult,
  HistoryResult,
  ListChecksResult,
  ListRecipesResult,
  ReportResult,
  SimNoticeResult,
  StoredSession,
  UninstallDoneResult,
} from '@opensip-cli/contracts';

const SPACER: ViewNode = { kind: 'spacer' };
const SEPARATOR: ViewNode = { kind: 'separator' };
const SIMULATION_TOOL_TITLE = 'Simulation';

// --- list-checks ----------------------------------------------------------

export function viewListChecks(result: ListChecksResult): ViewNode {
  const tagGroups = new Map<string, ListChecksResult['checks'][number][]>();
  for (const check of result.checks) {
    const tags = check.tags.length > 0 ? check.tags : ['untagged'];
    for (const tag of tags) {
      const existing = tagGroups.get(tag);
      if (existing) existing.push(check);
      else tagGroups.set(tag, [check]);
    }
  }
  const sortedTags = [...tagGroups.entries()].sort(([a], [b]) => a.localeCompare(b));

  const children: ViewNode[] = [
    line([
      // Task 3.4: a non-fitness producer (e.g. `graph list`) may supply its own
      // heading; default to the fitness label so `fit-list` is unchanged.
      { text: result.title ?? 'Available Fitness Checks', bold: true },
      { text: ` (${result.totalCount} total)`, dim: true },
    ]),
    SPACER,
  ];
  for (const [tag, tagChecks] of sortedTags) {
    // tagChecks is a freshly-built array owned by this function — sort in
    // place (no copy): avoids both a spread-in-loop (performance-anti-patterns
    // fitness check) and Array#slice (unicorn/prefer-spread eslint rule).
    tagChecks.sort((a, b) => a.slug.localeCompare(b.slug));
    const block: ViewNode[] = [
      line([
        { text: tag, tone: 'brand' },
        { text: ` (${tagChecks.length})`, dim: true },
      ]),
    ];
    for (const c of tagChecks) {
      block.push(line([{ text: `    ${c.slug} ` }, { text: `— ${c.description}`, dim: true }]));
    }
    block.push(SPACER);
    children.push(group(block, 2));
  }
  return group(children);
}

// --- list-recipes ---------------------------------------------------------

export function viewListRecipes(result: ListRecipesResult): ViewNode {
  const children: ViewNode[] = [line([{ text: 'Available Recipes', bold: true }]), SPACER];
  for (const r of result.recipes) {
    const label = r.selectionLabel ?? r.checkCount;
    children.push(
      line([
        { text: '  ' },
        { text: r.name, tone: 'brand' },
        { text: ` — ${r.description} ` },
        { text: `(${label})`, dim: true },
      ]),
    );
  }
  return group(children);
}

// --- history --------------------------------------------------------------

function scoreTone(score: number): Tone {
  if (score >= 90) return 'success';
  if (score >= 70) return 'warning';
  return 'error';
}

function payloadCounts(payload: unknown): { passed: number; total: number } | null {
  if (payload === null || typeof payload !== 'object') return null;
  const summary = (payload as { summary?: unknown }).summary;
  if (summary === null || typeof summary !== 'object') return null;
  const { passed, total } = summary as { passed?: unknown; total?: unknown };
  return typeof passed === 'number' && typeof total === 'number' ? { passed, total } : null;
}

/** One table row (one span per column) for a stored session. */
function historyRow(s: StoredSession): Span[] {
  const counts = payloadCounts(s.payload);
  return [
    { text: s.id, dim: true },
    { text: s.tool, tone: 'brand', bold: true },
    { text: new Date(s.startedAt).toLocaleString(), dim: true },
    { text: `${s.score}%`, tone: scoreTone(s.score) },
    { text: s.passed ? 'PASS' : 'FAIL', tone: s.passed ? 'success' : 'error' },
    { text: counts ? `${counts.passed}/${counts.total}` : '—' },
    { text: s.recipe ?? '', dim: true },
    { text: `${(s.durationMs / 1000).toFixed(1)}s`, dim: true },
  ];
}

/** Columns for the run-history table — Score/Checks/Duration right-align. */
const HISTORY_COLUMNS: readonly (string | TableColumnSpec)[] = [
  'Session',
  'Tool',
  'When',
  { header: 'Score', align: 'right' },
  'Status',
  { header: 'Checks', align: 'right' },
  'Recipe',
  { header: 'Duration', align: 'right' },
];

export function viewHistory(result: HistoryResult): ViewNode {
  if (result.sessions.length === 0) {
    return group(
      [
        line([
          {
            text: 'No sessions recorded yet. Run opensip fit to generate data.',
            dim: true,
          },
        ]),
      ],
      2,
    );
  }
  const visible = result.sessions.slice(0, 20);
  return group([
    line([
      { text: 'Run History', bold: true },
      { text: ` (${result.sessions.length} sessions)`, dim: true },
    ]),
    SPACER,
    group([viewTable(HISTORY_COLUMNS, visible.map(historyRow))], 2),
  ]);
}

// --- sim notice ------------------------------------------------------------

export function viewSimNotice(_result: SimNoticeResult): ViewNode {
  return group([
    group(
      [
        line([{ text: SIMULATION_TOOL_TITLE, tone: 'brand', bold: true }]),
        SPACER,
        line([
          {
            text: 'Run scenario-based tests against your codebase.',
            dim: true,
          },
        ]),
        SPACER,
        SEPARATOR,
      ],
      2,
    ),
    group(
      [
        SPACER,
        line([{ text: 'Status:', tone: 'success' }, { text: ' Available in OpenSIP CLI 1.0.0.' }]),
        line([{ text: '  Use opensip sim --recipes to list registered recipes.' }]),
        SPACER,
        line([
          {
            text: '  → https://github.com/opensip-ai/opensip-cli/issues',
            dim: true,
          },
        ]),
      ],
      2,
    ),
  ]);
}

// --- help -----------------------------------------------------------------

export function viewHelp(): ViewNode {
  return group(
    [
      line([{ text: 'opensip-cli', bold: true }]),
      line([{ text: 'Codebase intelligence from your terminal', dim: true }]),
      SPACER,
      line([{ text: 'Commands:', bold: true }]),
      line([{ text: '  ' }, { text: 'fit', tone: 'brand' }, { text: '     Run fitness checks' }]),
      line([{ text: '  ' }, { text: 'init', tone: 'brand' }, { text: '    Generate config file' }]),
      line([
        { text: '  ' },
        { text: 'sim', tone: 'brand' },
        { text: '     Run simulation scenarios' },
      ]),
      line([{ text: '  ' }, { text: 'plugin', tone: 'brand' }, { text: '  Manage plugins' }]),
      SPACER,
      line([{ text: 'Run opensip-cli <command> --help for details.', dim: true }]),
    ],
    2,
  );
}

// --- report ---------------------------------------------------------------

export function viewReport(result: ReportResult): ViewNode {
  return group(
    [
      line([
        { text: '✓', tone: 'success' },
        { text: ' Report written to ' },
        { text: result.path, bold: true },
      ]),
      line([
        {
          text: `  ${result.opened ? 'Opened in browser.' : 'Open the file in your browser to view.'}`,
          dim: true,
        },
      ]),
    ],
    2,
  );
}

// --- clear-done -----------------------------------------------------------

export function viewClearDone(result: ClearDoneResult): ViewNode {
  if (result.action === 'empty')
    return group([line([{ text: 'No session data to clear.', dim: true }])], 2);
  if (result.action === 'cancelled')
    return group([line([{ text: 'Cancelled. No data was deleted.', dim: true }])], 2);
  const plural = result.deletedCount === 1 ? '' : 's';
  return group(
    [
      line([
        { text: '✓', tone: 'success' },
        { text: ` ${result.deletedCount} session${plural} deleted.` },
      ]),
    ],
    2,
  );
}

// --- graph lookup ---------------------------------------------------------

export function viewGraphLookup(result: {
  readonly name: string;
  readonly resolutionMode: 'exact' | 'fast';
  readonly matches: readonly unknown[];
}): ViewNode {
  const count = result.matches.length;
  const plural = count === 1 ? '' : 's';
  return group(
    [
      line([
        { text: `${result.name} — ${String(count)} occurrence${plural}` },
        ...(result.resolutionMode === 'fast'
          ? [{ text: ' (fast catalog — edges approximate)', dim: true }]
          : []),
      ]),
    ],
    2,
  );
}

// --- config commands ------------------------------------------------------

export function viewConfigValidate(result: {
  readonly configPath: string;
  readonly namespaces: readonly string[];
  readonly warnings?: readonly string[];
}): ViewNode {
  const children: ViewNode[] = [
    line([
      { text: '✓', tone: 'success' },
      { text: ' Configuration valid: ' },
      { text: result.configPath, bold: true },
      {
        text: ` (${String(result.namespaces.length)} namespace${result.namespaces.length === 1 ? '' : 's'})`,
      },
    ]),
  ];
  if (result.warnings !== undefined) {
    for (const warning of result.warnings) {
      children.push(line([{ text: `  ${warning}`, dim: true }]));
    }
  }
  return group(children, 2);
}

export function viewConfigSchema(result: { readonly outPath?: string }): ViewNode {
  if (result.outPath !== undefined) {
    return group(
      [
        line([
          { text: '✓', tone: 'success' },
          { text: ' Wrote JSON Schema to ' },
          { text: result.outPath, bold: true },
        ]),
      ],
      2,
    );
  }
  return group(
    [
      line([
        {
          text: 'Use --json to print the schema or --out <path> to write it to a file.',
          dim: true,
        },
      ]),
    ],
    2,
  );
}

// --- configure-done -------------------------------------------------------

export function viewConfigureDone(result: ConfigureDoneResult): ViewNode {
  if (result.action === 'cancelled') {
    return group([line([{ text: 'No key provided. Configuration unchanged.', dim: true }])], 2);
  }
  return group(
    [
      line([
        { text: '✓', tone: 'success' },
        { text: ' API key saved to ' },
        { text: result.configPath, bold: true },
      ]),
      line([
        {
          text: '  You can now use --report-to to send results to OpenSIP Cloud.',
          dim: true,
        },
      ]),
    ],
    2,
  );
}

// --- uninstall-done -------------------------------------------------------

export function viewUninstallDone(result: UninstallDoneResult): ViewNode {
  const sizeText = formatBytes(result.sizeBytes);
  const count = result.targets.length;
  const plural = count === 1 ? '' : 's';

  if (result.action === 'empty')
    return group([line([{ text: `Nothing to remove at ${result.rootPath}.`, dim: true }])], 2);
  if (result.action === 'cancelled')
    return group([line([{ text: 'Cancelled. No changes made.', dim: true }])], 2);
  if (result.action === 'dry-run') {
    return group(
      [
        line([
          {
            text: `[dry-run] No changes made. Re-run without --dry-run to remove ${count} target${plural} (${sizeText}).`,
            dim: true,
          },
        ]),
      ],
      2,
    );
  }
  const hint =
    result.mode === 'user'
      ? 'To remove the CLI itself: npm uninstall -g opensip-cli'
      : 'To also remove user-level config: opensip uninstall';
  return group(
    [
      line([
        { text: '✓', tone: 'success' },
        { text: ` Removed ${count} target${plural} ` },
        { text: `(${sizeText})`, dim: true },
      ]),
      line([{ text: `  ${hint}`, dim: true }]),
    ],
    2,
  );
}
