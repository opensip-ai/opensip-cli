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

import { dashboardSessionsJs } from '../sessions.js';
import { dashboardElJs } from '../shared/el.js';
import { dashboardPaginationJs } from '../shared/pagination.js';
import { dashboardSortableJs } from '../shared/sortable.js';

interface StoredSessionLike {
  id: string;
  tool: 'fit' | 'sim' | 'graph';
  timestamp: string;
  cwd: string;
  recipe?: string;
  score: number;
  passed: boolean;
  durationMs: number;
  payload?: unknown;
}

interface Env {
  render: (sessions: StoredSessionLike[]) => HTMLElement;
}

function loadEnv(): Env {
  const tail = `
return {
  render: function(sessions) {
    const panel = document.createElement('div');
    renderSessionTable(panel, sessions, 'var(--accent)');
    return panel;
  },
};
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own emitted dashboard JS.
  const factory = new Function(
    dashboardElJs()
      + dashboardPaginationJs()
      + dashboardSortableJs()
      + dashboardSessionsJs()
      + tail,
  );
  return factory() as Env;
}

function makeSession(over: Partial<StoredSessionLike> = {}): StoredSessionLike {
  return {
    id: 's1',
    tool: 'fit',
    timestamp: '2026-05-29T10:30:00.000Z',
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
  return sections.find(s => s.querySelector('h3')?.textContent?.startsWith('Session Detail')) ?? null;
}

beforeEach(() => { document.body.innerHTML = ''; });

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
              findings: [{ ruleId: 'no-console-log', message: 'console.log left in', severity: 'error', filePath: 'src/a.ts', line: 3 }],
            },
          ],
        },
      }),
    ]);

    const detail = detailSection(panel);
    expect(detail).not.toBeNull();
    const headers = [...detail!.querySelectorAll('thead th')].map(th => th.textContent);
    expect(headers).toContain('Check');
    expect(headers).not.toContain('Rule');
    // The check's slug renders in a row.
    expect(detail!.textContent).toContain('no-console-log');
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
                { ruleId: 'graph:duplicated-function-body', message: 'dup body', severity: 'warning', filePath: 'src/x.ts', line: 1 },
                { ruleId: 'graph:duplicated-function-body', message: 'dup body', severity: 'warning', filePath: 'src/y.ts', line: 9 },
              ],
            },
          ],
        },
      }),
    ]);

    const detail = detailSection(panel);
    expect(detail).not.toBeNull();
    const headers = [...detail!.querySelectorAll('thead th')].map(th => th.textContent);
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
});
