/**
 * Narrow unit coverage for the dashboard plane (host-owned-run-timing Phase 5
 * §7 / Phase 6 §6.1 / Task 6.2). Covers the contribution → ContributedTab
 * transform: per-tool namespacing, duplicate-id drop, inline-row resolution
 * from `data[dataKey]`, and the host-reserved top-level keys.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  isReservedDashboardKey,
  resolveContributedTabs,
  type PersistedDashboardContribution,
} from '../dashboard-plane.js';

import type {
  DashboardViewContribution,
  Logger,
  ToolDashboardContribution,
} from '@opensip-cli/core';

const TABLE_VIEW: DashboardViewContribution = { kind: 'table', columns: [] };
const CARDS_VIEW: DashboardViewContribution = { kind: 'cards', fields: [] };

function silentLogger(): { log: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }, warn };
}

function entry(
  tool: string,
  contribution: ToolDashboardContribution,
  sessionId = 'ses-1',
): PersistedDashboardContribution {
  return { sessionId, tool, contribution };
}

describe('isReservedDashboardKey', () => {
  it('reserves the host-owned top-level shell keys', () => {
    expect(isReservedDashboardKey('sessions')).toBe(true);
    expect(isReservedDashboardKey('contributedTabs')).toBe(true);
    expect(isReservedDashboardKey('graphCatalog')).toBe(false);
  });
});

describe('resolveContributedTabs', () => {
  it('namespaces each tab by producing tool and resolves inline rows from data[dataKey]', () => {
    const { log } = silentLogger();
    const tabs = resolveContributedTabs(
      [
        entry('fit', {
          tabs: [
            { id: 'findings', title: 'Findings', view: TABLE_VIEW, dataKey: 'rows', order: 2 },
          ],
          data: { rows: [{ a: 1 }, { a: 2 }] },
        }),
      ],
      log,
    );
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      id: 'contrib-fit-findings',
      title: 'Findings',
      order: 2,
      view: TABLE_VIEW,
      rows: [{ a: 1 }, { a: 2 }],
    });
  });

  it('coerces a missing/non-array dataKey to empty rows', () => {
    const { log } = silentLogger();
    const tabs = resolveContributedTabs(
      [
        entry('fit', {
          tabs: [{ id: 't', title: 'T', view: CARDS_VIEW, dataKey: 'nope' }],
          data: {},
        }),
      ],
      log,
    );
    expect(tabs[0]?.rows).toEqual([]);
  });

  it('drops a duplicate namespaced id (same tool + tab id) with a warning', () => {
    const { log, warn } = silentLogger();
    const tabs = resolveContributedTabs(
      [
        entry(
          'fit',
          { tabs: [{ id: 'dup', title: 'First', view: TABLE_VIEW }], data: {} },
          'ses-1',
        ),
        entry(
          'fit',
          { tabs: [{ id: 'dup', title: 'Second', view: TABLE_VIEW }], data: {} },
          'ses-2',
        ),
      ],
      log,
    );
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.title).toBe('First');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('keeps same tab id across different tools (no collision)', () => {
    const { log } = silentLogger();
    const tabs = resolveContributedTabs(
      [
        entry('fit', { tabs: [{ id: 'x', title: 'Fit', view: TABLE_VIEW }], data: {} }),
        entry('graph', { tabs: [{ id: 'x', title: 'Graph', view: TABLE_VIEW }], data: {} }),
      ],
      log,
    );
    expect(tabs.map((t) => t.id)).toEqual(['contrib-fit-x', 'contrib-graph-x']);
  });

  it('ignores a contribution whose tabs is not an array', () => {
    const { log } = silentLogger();
    const tabs = resolveContributedTabs(
      [{ sessionId: 's', tool: 'fit', contribution: { tabs: 'nope' } }],
      log,
    );
    expect(tabs).toEqual([]);
  });
});
