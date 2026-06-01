/**
 * View-model builders for the remaining result types: list-checks,
 * list-recipes, history, experimental, dashboard, help, and the
 * clear/configure/uninstall "done" summaries. Each reproduces the visible
 * output of its retired Ink component as a renderer-agnostic ViewNode.
 */

import { line, group, type Span, type Tone, type ViewNode } from '@opensip-tools/cli-ui';

import type {
  ClearDoneResult,
  ConfigureDoneResult,
  DashboardResult,
  ExperimentalResult,
  HistoryResult,
  ListChecksResult,
  ListRecipesResult,
  StoredSession,
  UninstallDoneResult,
} from '@opensip-tools/contracts';

const SPACER: ViewNode = { kind: 'spacer' };
const SEPARATOR: ViewNode = { kind: 'separator' };
const SIMULATION_TOOL_TITLE = 'Simulation';

// --- list-checks ----------------------------------------------------------

export function viewListChecks(result: ListChecksResult): ViewNode {
  const tagGroups = new Map<string, ListChecksResult['checks']>();
  for (const check of result.checks) {
    const tags = check.tags.length > 0 ? check.tags : ['untagged'];
    for (const tag of tags) {
      const list = [...(tagGroups.get(tag) ?? []), check];
      tagGroups.set(tag, list);
    }
  }
  const sortedTags = [...tagGroups.entries()].sort(([a], [b]) => a.localeCompare(b));

  const children: ViewNode[] = [
    line([{ text: 'Available Fitness Checks', bold: true }, { text: ` (${result.totalCount} total)`, dim: true }]),
    SPACER,
  ];
  for (const [tag, tagChecks] of sortedTags) {
    const sorted = [...tagChecks].sort((a, b) => a.slug.localeCompare(b.slug));
    const block: ViewNode[] = [line([{ text: tag, tone: 'brand' }, { text: ` (${tagChecks.length})`, dim: true }])];
    for (const c of sorted) {
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
    children.push(
      line([
        { text: '  ' },
        { text: r.name, tone: 'brand' },
        { text: ` — ${r.description} ` },
        { text: `(${r.checkCount})`, dim: true },
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

function historyRow(s: StoredSession): ViewNode {
  const date = new Date(s.timestamp).toLocaleString();
  const duration = `${(s.durationMs / 1000).toFixed(1)}s`;
  const counts = payloadCounts(s.payload);
  const spans: Span[] = [
    { text: '  ' },
    { text: date, dim: true },
    { text: '  ' },
    { text: `${s.score}%`, tone: scoreTone(s.score) },
    { text: '  ' },
    { text: s.passed ? 'PASS' : 'FAIL', tone: s.passed ? 'success' : 'error' },
    { text: '  ' },
    { text: counts ? `${counts.passed}/${counts.total} checks` : '' },
  ];
  if (s.recipe !== undefined) spans.push({ text: ` (${s.recipe})`, dim: true });
  spans.push({ text: '  ' }, { text: duration, dim: true });
  return line(spans);
}

export function viewHistory(result: HistoryResult): ViewNode {
  if (result.sessions.length === 0) {
    return group([line([{ text: 'No sessions recorded yet. Run opensip-tools fit to generate data.', dim: true }])], 2);
  }
  const visible = result.sessions.slice(0, 20);
  return group([
    line([{ text: 'Run History', bold: true }, { text: ` (${result.sessions.length} sessions)`, dim: true }]),
    SPACER,
    ...visible.map(historyRow),
  ]);
}

// --- experimental (sim notice) --------------------------------------------

export function viewExperimental(_result: ExperimentalResult): ViewNode {
  return group([
    group(
      [
        line([{ text: SIMULATION_TOOL_TITLE, tone: 'brand', bold: true }]),
        SPACER,
        line([{ text: 'Run scenario-based tests against your codebase.', dim: true }]),
        SPACER,
        SEPARATOR,
      ],
      2,
    ),
    group(
      [
        SPACER,
        line([{ text: 'Status:', tone: 'warning' }, { text: ' Under active development — not yet available for use.' }]),
        line([{ text: "  We're looking for contributors to help build this out!" }]),
        SPACER,
        line([{ text: '  → https://github.com/opensip-ai/opensip-tools/issues', dim: true }]),
      ],
      2,
    ),
  ]);
}

// --- help -----------------------------------------------------------------

export function viewHelp(): ViewNode {
  return group(
    [
      line([{ text: 'opensip-tools', bold: true }]),
      line([{ text: 'Codebase analysis toolkit', dim: true }]),
      SPACER,
      line([{ text: 'Commands:', bold: true }]),
      line([{ text: '  ' }, { text: 'fit', tone: 'brand' }, { text: '     Run fitness checks' }]),
      line([{ text: '  ' }, { text: 'init', tone: 'brand' }, { text: '    Generate config file' }]),
      line([{ text: '  ' }, { text: 'sim', tone: 'brand' }, { text: '     Run simulation scenarios [experimental]' }]),
      line([{ text: '  ' }, { text: 'plugin', tone: 'brand' }, { text: '  Manage plugins' }]),
      SPACER,
      line([{ text: 'Run opensip-tools <command> --help for details.', dim: true }]),
    ],
    2,
  );
}

// --- dashboard ------------------------------------------------------------

export function viewDashboard(result: DashboardResult): ViewNode {
  return group(
    [
      line([{ text: '✓', tone: 'success' }, { text: ' Report written to ' }, { text: result.path, bold: true }]),
      line([{ text: `  ${result.opened ? 'Opened in browser.' : 'Open the file in your browser to view.'}`, dim: true }]),
    ],
    2,
  );
}

// --- clear-done -----------------------------------------------------------

export function viewClearDone(result: ClearDoneResult): ViewNode {
  if (result.action === 'empty') return group([line([{ text: 'No session data to clear.', dim: true }])], 2);
  if (result.action === 'cancelled') return group([line([{ text: 'Cancelled. No data was deleted.', dim: true }])], 2);
  const plural = result.deletedCount === 1 ? '' : 's';
  return group([line([{ text: '✓', tone: 'success' }, { text: ` ${result.deletedCount} session${plural} deleted.` }])], 2);
}

// --- configure-done -------------------------------------------------------

export function viewConfigureDone(result: ConfigureDoneResult): ViewNode {
  if (result.action === 'cancelled') {
    return group([line([{ text: 'No key provided. Configuration unchanged.', dim: true }])], 2);
  }
  return group(
    [
      line([{ text: '✓', tone: 'success' }, { text: ' API key saved to ' }, { text: result.configPath, bold: true }]),
      line([{ text: '  You can now use --report-to to send results to OpenSIP Cloud.', dim: true }]),
    ],
    2,
  );
}

// --- uninstall-done -------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function viewUninstallDone(result: UninstallDoneResult): ViewNode {
  const sizeText = formatBytes(result.sizeBytes);
  const count = result.targets.length;
  const plural = count === 1 ? '' : 's';

  if (result.action === 'empty') return group([line([{ text: `Nothing to remove at ${result.rootPath}.`, dim: true }])], 2);
  if (result.action === 'cancelled') return group([line([{ text: 'Cancelled. No changes made.', dim: true }])], 2);
  if (result.action === 'dry-run') {
    return group(
      [line([{ text: `[dry-run] No changes made. Re-run without --dry-run to remove ${count} target${plural} (${sizeText}).`, dim: true }])],
      2,
    );
  }
  const hint =
    result.mode === 'user'
      ? 'To remove the CLI itself: npm uninstall -g opensip-tools'
      : 'To also remove user-level config: opensip-tools uninstall';
  return group(
    [
      line([{ text: '✓', tone: 'success' }, { text: ` Removed ${count} target${plural} ` }, { text: `(${sizeText})`, dim: true }]),
      line([{ text: `  ${hint}`, dim: true }]),
    ],
    2,
  );
}
