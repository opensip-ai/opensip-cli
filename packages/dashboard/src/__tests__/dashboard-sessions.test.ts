/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Shared session table + session-detail renderer tests
 * (`dashboardSessionsJs`). Covers the three payload states the renderer
 * must distinguish:
 *   1. fitness payload → per-check detail, "Check" column.
 *   2. graph payload   → per-rule detail, "Rule" column (same structural
 *      shape, tool-specific label).
 *   3. no payload      → explicit "No detail recorded" instead of a
 *      silent empty table (covers pre-payload-split sessions).
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { DASHBOARD_CLIENT_BUNDLE } from '../client-bundle.generated.js';

interface StoredSessionLike {
  id: string;
  tool: 'fit' | 'sim' | 'graph' | 'yagni';
  startedAt: string;
  completedAt: string;
  cwd: string;
  recipe?: string;
  score: number;
  passed: boolean;
  runOutcome?: 'passed' | 'failed' | 'degraded' | 'error';
  durationMs: number;
  payload?: unknown;
}

interface Env {
  render: (sessions: StoredSessionLike[]) => HTMLElement;
}

function loadEnv(): Env {
  // The bundle now contains every renderer, so loading it runs each module's
  // top-level code — including checks.ts's `computeCheckStats()`, which reads the
  // page-global `sessions` at load. Define the data globals the generated page's
  // <script> const block would provide before the bundle runs.
  const dataPrelude = `var sessions = [];\n`;
  const tail = `
return {
  render: function(toolSessions) {
    const panel = document.createElement('div');
    renderSessionTable(panel, toolSessions, 'var(--accent)');
    return panel;
  },
};
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own emitted dashboard JS.
  const factory = new Function(
    // `renderSessionTable` (with `el`, the paginators and `makeSortable`) now all
    // live in the bundled client modules and are exposed as page globals; the
    // session table is built entirely from the bundle.
    dataPrelude + DASHBOARD_CLIENT_BUNDLE + '\n' + tail,
  );
  return factory() as Env;
}

function makeSession(over: Partial<StoredSessionLike> = {}): StoredSessionLike {
  return {
    id: 's1',
    tool: 'fit',
    startedAt: '2026-05-29T10:30:00.000Z',
    completedAt: '2026-05-29T10:30:00.000Z',
    cwd: '/repo',
    recipe: 'default',
    score: 100,
    passed: true,
    durationMs: 1200,
    ...over,
  };
}

/** The detail panel is the `.section` whose heading starts "Session Detail". */
function detailSection(panel: HTMLElement): HTMLElement | null {
  const sections = [...panel.querySelectorAll<HTMLElement>('.section')];
  return (
    sections.find((s) => s.querySelector('h3')?.textContent?.startsWith('Session Detail')) ?? null
  );
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('renderSessionTable / renderDetail', () => {
  it('renders per-check detail with a "Check" column for a fitness payload', () => {
    const panel = loadEnv().render([
      makeSession({
        tool: 'fit',
        payload: {
          summary: { total: 1, passed: 0, failed: 1, errors: 1, warnings: 0 },
          checks: [
            {
              checkSlug: 'no-console-log',
              passed: false,
              violationCount: 1,
              durationMs: 5,
              findings: [
                {
                  ruleId: 'no-console-log',
                  message: 'console.log left in',
                  severity: 'error',
                  filePath: 'src/a.ts',
                  line: 3,
                },
              ],
            },
          ],
        },
      }),
    ]);

    const detail = detailSection(panel);
    expect(detail).not.toBeNull();
    const headers = [...detail!.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headers).toContain('Check');
    expect(headers).not.toContain('Rule');
    // The check's slug renders in a row.
    expect(detail!.textContent).toContain('no-console-log');
  });

  it('renders per-detector detail with a "Detector" column for a yagni payload', () => {
    const panel = loadEnv().render([
      makeSession({
        id: 'y1',
        tool: 'yagni',
        payload: {
          summary: { total: 1, passed: 0, failed: 1, errors: 0, warnings: 1 },
          // Yagni conforms to the shared payload.checks contract — one "check"
          // per detector, keyed by checkSlug (host relabels the column).
          checks: [
            {
              checkSlug: 'unused-export',
              passed: false,
              violationCount: 1,
              durationMs: 4,
              findings: [
                {
                  ruleId: 'unused-export',
                  message: 'export with no importers',
                  severity: 'warning',
                  filePath: 'src/a.ts',
                  line: 7,
                },
              ],
            },
          ],
        },
      }),
    ]);

    const detail = detailSection(panel);
    expect(detail).not.toBeNull();
    const headers = [...detail!.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headers).toContain('Detector');
    expect(headers).not.toContain('Check');
    expect(headers).not.toContain('Rule');
    // The detector's slug renders in a row (detail was actually recorded — the
    // regression was an empty "No per-rule detail" panel from a mismatched key).
    expect(detail!.textContent).toContain('unused-export');
  });

  it('renders per-rule detail with a "Rule" column for a graph payload', () => {
    const panel = loadEnv().render([
      makeSession({
        id: 'g1',
        tool: 'graph',
        recipe: 'graph',
        payload: {
          summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 2 },
          checks: [
            {
              checkSlug: 'graph:duplicated-function-body',
              passed: true,
              violationCount: 2,
              durationMs: 0,
              findings: [
                {
                  ruleId: 'graph:duplicated-function-body',
                  message: 'dup body',
                  severity: 'warning',
                  filePath: 'src/x.ts',
                  line: 1,
                },
                {
                  ruleId: 'graph:duplicated-function-body',
                  message: 'dup body',
                  severity: 'warning',
                  filePath: 'src/y.ts',
                  line: 9,
                },
              ],
            },
          ],
        },
      }),
    ]);

    const detail = detailSection(panel);
    expect(detail).not.toBeNull();
    const headers = [...detail!.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headers).toContain('Rule');
    expect(headers).not.toContain('Check');
    expect(detail!.textContent).toContain('graph:duplicated-function-body');
  });

  it('shows an explicit "No detail recorded" message when a session has no payload', () => {
    const panel = loadEnv().render([makeSession({ payload: undefined })]);
    const detail = detailSection(panel);
    expect(detail).not.toBeNull();
    expect(detail!.textContent).toContain('No detail recorded for this session.');
    // No findings/detail table when there is no payload.
    expect(detail!.querySelector('table.data-table')).toBeNull();
  });

  it('omits the per-rule Duration column for a graph session', () => {
    const panel = loadEnv().render([
      makeSession({
        id: 'g2',
        tool: 'graph',
        recipe: 'graph',
        payload: {
          summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 1 },
          checks: [
            {
              checkSlug: 'graph:cycle',
              passed: true,
              violationCount: 1,
              durationMs: 0,
              findings: [
                {
                  ruleId: 'graph:cycle',
                  message: 'cycle',
                  severity: 'warning',
                  filePath: 'src/x.ts',
                  line: 1,
                  metadata: { sccSize: 4 },
                },
              ],
            },
          ],
        },
      }),
    ]);
    const detail = detailSection(panel);
    const headers = [...detail!.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headers).not.toContain('Duration');
  });

  it('keeps the per-check Duration column for a fitness session', () => {
    const panel = loadEnv().render([
      makeSession({
        tool: 'fit',
        payload: {
          summary: { total: 1, passed: 0, failed: 1, errors: 1, warnings: 0 },
          checks: [
            {
              checkSlug: 'no-console-log',
              passed: false,
              violationCount: 1,
              durationMs: 5,
              findings: [
                {
                  ruleId: 'no-console-log',
                  message: 'm',
                  severity: 'error',
                  filePath: 'src/a.ts',
                  line: 3,
                },
              ],
            },
          ],
        },
      }),
    ]);
    const detail = detailSection(panel);
    const headers = [...detail!.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headers).toContain('Duration');
  });

  it('renders the per-rule metric column (Lines from metadata.bodyLines) for graph:large-function, dropping Message', () => {
    const panel = loadEnv().render([
      makeSession({
        id: 'g3',
        tool: 'graph',
        recipe: 'graph',
        payload: {
          summary: { total: 1, passed: 0, failed: 1, errors: 1, warnings: 0 },
          checks: [
            {
              checkSlug: 'graph:large-function',
              passed: false,
              violationCount: 1,
              durationMs: 0,
              findings: [
                {
                  ruleId: 'graph:large-function',
                  message: 'foo is 321 lines long.',
                  severity: 'error',
                  filePath: 'src/big.ts',
                  line: 10,
                  metadata: { bodyLines: 321 },
                },
              ],
            },
          ],
        },
      }),
    ]);
    const detail = detailSection(panel);
    // Expand the rule row to reveal the findings table.
    detail!.querySelector<HTMLElement>('tbody tr.clickable')!.click();
    const findingsHeaders = [...detail!.querySelectorAll('.expander-content thead th')].map(
      (th) => th.textContent,
    );
    expect(findingsHeaders).toEqual(['Severity', 'File', 'Lines', 'Suggestion']);
    expect(detail!.querySelector('.expander-content')!.textContent).toContain('321');
    // Message column is dropped — the verbose message must not appear.
    expect(detail!.querySelector('.expander-content')!.textContent).not.toContain(
      'is 321 lines long',
    );
  });

  it('falls back to a dash when the metric metadata is missing', () => {
    const panel = loadEnv().render([
      makeSession({
        id: 'g4',
        tool: 'graph',
        recipe: 'graph',
        payload: {
          summary: { total: 1, passed: 0, failed: 1, errors: 1, warnings: 0 },
          checks: [
            {
              checkSlug: 'graph:wide-function',
              passed: false,
              violationCount: 1,
              durationMs: 0,
              findings: [
                {
                  ruleId: 'graph:wide-function',
                  message: 'wide',
                  severity: 'error',
                  filePath: 'src/w.ts',
                  line: 2,
                },
              ],
            },
          ],
        },
      }),
    ]);
    const detail = detailSection(panel);
    detail!.querySelector<HTMLElement>('tbody tr.clickable')!.click();
    const headers = [...detail!.querySelectorAll('.expander-content thead th')].map(
      (th) => th.textContent,
    );
    expect(headers).toEqual(['Severity', 'File', 'Parameters', 'Suggestion']);
    // The Parameters cell shows the em-dash fallback.
    const cells = [...detail!.querySelectorAll('.expander-content tbody td')].map(
      (td) => td.textContent,
    );
    expect(cells).toContain('—');
  });

  it('sorts findings within a rule errors-first', () => {
    const panel = loadEnv().render([
      makeSession({
        id: 'g5',
        tool: 'graph',
        recipe: 'graph',
        payload: {
          summary: { total: 1, passed: 0, failed: 1, errors: 1, warnings: 2 },
          checks: [
            {
              checkSlug: 'graph:duplicated-function-body',
              passed: false,
              violationCount: 3,
              durationMs: 0,
              findings: [
                {
                  ruleId: 'graph:duplicated-function-body',
                  message: 'w1',
                  severity: 'warning',
                  filePath: 'src/a.ts',
                  line: 1,
                },
                {
                  ruleId: 'graph:duplicated-function-body',
                  message: 'e1',
                  severity: 'error',
                  filePath: 'src/b.ts',
                  line: 2,
                },
                {
                  ruleId: 'graph:duplicated-function-body',
                  message: 'w2',
                  severity: 'warning',
                  filePath: 'src/c.ts',
                  line: 3,
                },
              ],
            },
          ],
        },
      }),
    ]);
    const detail = detailSection(panel);
    detail!.querySelector<HTMLElement>('tbody tr.clickable')!.click();
    const sevs = [...detail!.querySelectorAll('.expander-content tbody .finding-sev')].map(
      (s) => s.textContent,
    );
    expect(sevs[0]).toBe('error');
    expect(sevs.slice(1)).toEqual(['warning', 'warning']);
  });

  it('shows ERROR badge and error score color for runOutcome:error sessions (ADR-0060)', () => {
    const panel = loadEnv().render([
      makeSession({
        score: 100,
        passed: false,
        runOutcome: 'error',
        payload: {
          summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
        },
      }),
    ]);
    const badge = panel.querySelector('.badge')?.textContent;
    expect(badge).toBe('ERROR');
    const scoreCell = panel.querySelector('tbody tr td:nth-child(3)');
    expect(scoreCell?.style.color).toContain('var(--error)');
  });

  it('shows DEGRADED badge for runOutcome:degraded sessions (ADR-0060)', () => {
    const panel = loadEnv().render([
      makeSession({
        score: 85,
        passed: true,
        runOutcome: 'degraded',
        payload: {
          summary: { total: 2, passed: 2, failed: 0, errors: 0, warnings: 0 },
        },
      }),
    ]);
    expect(panel.querySelector('.badge')?.textContent).toBe('DEGRADED');
  });
});
