/**
 * Tests for the CLI report composition root (audit 2026-05-29, L2).
 *
 * `composeAndWriteReport` is what decouples fitness from graph: it
 * walks every registered tool's `collectReportData(scope)`
 * contribution, merges them onto the shared HTML report input, renders the
 * cross-tool HTML, and writes it to the project's reports directory. No
 * single tool owns composition.
 *
 * These tests construct a real `RunScope` with stub tools and a temp
 * project root, run inside `runWithScope`, and assert: (1) every tool's
 * contribution is merged, (2) the file is written to the resolved reports
 * path, (3) the rendered HTML carries the cross-tool panels, and (4)
 * tools without `collectReportData` are skipped gracefully.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LanguageRegistry,
  RunScope,
  ToolRegistry,
  resolveProjectPaths,
  runWithScope,
} from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { SessionRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as openReportMod from '../open-report.js';
import { composeAndWriteReport } from '../report-compose.js';

import type { ProjectContext, Tool, ToolDashboardContribution, ToolScope } from '@opensip-cli/core';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'opensip-dash-compose-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projectRoot, { recursive: true, force: true });
});

function makeTool(id: string, contribution?: Record<string, unknown>): Tool {
  return {
    metadata: { id, version: '0.0.0', description: id },
    commands: [],
    register: () => undefined,
    ...(contribution ? { collectReportData: (_scope: ToolScope) => contribution } : {}),
  };
}

function makeScope(tools: Tool[], datastore?: DataStore): RunScope {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  const projectContext: ProjectContext = {
    cwd: projectRoot,
    cwdExplicit: false,
    projectRoot,
    configPath: undefined,
    walkedUp: 0,
    scope: 'project',
  };
  return new RunScope({
    languages: new LanguageRegistry(),
    tools: registry,
    projectContext,
    runId: 'test-run',
    ...(datastore ? { datastore: () => datastore } : {}),
  });
}

/** Persist one fit session + a dashboard contribution for it; return the id. */
function seedSessionWithDashboard(
  ds: DataStore,
  tool: 'fit' | 'sim' | 'graph',
  dashboard: ToolDashboardContribution,
): string {
  const repo = new SessionRepo(ds);
  const id = `${tool}-sess-${tool}`;
  repo.save({
    id,
    tool,
    startedAt: '2026-06-14T10:00:00.000Z',
    completedAt: '2026-06-14T10:00:01.000Z',
    cwd: projectRoot,
    score: 100,
    passed: true,
    durationMs: 1000,
  });
  repo.saveDashboardContribution(id, tool, dashboard);
  return id;
}

describe('composeAndWriteReport', () => {
  it('merges every tool contribution and writes latest.html to the reports dir', async () => {
    // Don't actually launch a browser in tests.
    vi.spyOn(openReportMod, 'launchReport').mockResolvedValue(true);

    const scope = makeScope([
      makeTool('fitness', {
        checkCatalog: [{ slug: 'demo-check', name: 'Demo' }],
        recipeCatalog: [{ name: 'demo-recipe' }],
        editorProtocol: 'vscode',
      }),
      makeTool('graph', { graphCatalog: { functions: {}, files: {} } }),
      makeTool('simulation'), // no collectReportData — must be skipped
    ]);

    const result = await runWithScope(scope, () => composeAndWriteReport({ open: false }));

    const expectedPath = join(resolveProjectPaths(projectRoot).reportsDir, 'latest.html');
    expect(result).toEqual({ type: 'report', path: expectedPath, opened: false });

    const html = readFileSync(expectedPath, 'utf8');
    // Cross-tool panels are present.
    expect(html).toContain('id="panel-fitness"');
    expect(html).toContain('id="panel-simulation"');
    // Fitness's catalog contribution made it into the inlined data.
    expect(html).toContain('demo-check');
  });

  it('launches the browser only when open is true', async () => {
    const launch = vi.spyOn(openReportMod, 'launchReport').mockResolvedValue(true);
    const scope = makeScope([makeTool('fitness', { checkCatalog: [] })]);

    const noOpen = await runWithScope(scope, () => composeAndWriteReport({ open: false }));
    expect(launch).not.toHaveBeenCalled();
    expect(noOpen.opened).toBe(false);

    const opened = await runWithScope(scope, () => composeAndWriteReport({ open: true }));
    expect(launch).toHaveBeenCalledTimes(1);
    expect(opened.opened).toBe(true);
  });

  it('throws when invoked outside an entered RunScope', async () => {
    // No runWithScope wrapper ⇒ currentScope() is undefined ⇒ composition
    // refuses with a clear "requires an entered RunScope" error.
    await expect(composeAndWriteReport({ open: false })).rejects.toThrow(
      /requires an entered RunScope/,
    );
  });

  it('composes with zero contributing tools (sessions-only report)', async () => {
    vi.spyOn(openReportMod, 'launchReport').mockResolvedValue(true);
    const scope = makeScope([makeTool('simulation')]);

    const result = await runWithScope(scope, () => composeAndWriteReport({ open: false }));

    const html = readFileSync(result.path, 'utf8');
    expect(html).toContain('id="panel-fitness"');
    expect(result.opened).toBe(false);
  });
});

describe('composeAndWriteReport — contributed per-run dashboard tabs (Phase 5)', () => {
  let ds: DataStore;

  beforeEach(() => {
    ds = DataStoreFactory.open({ backend: 'memory' });
  });

  afterEach(() => {
    ds.close();
  });

  it('merges durable per-run contributions into namespaced contributedTabs', async () => {
    vi.spyOn(openReportMod, 'launchReport').mockResolvedValue(true);
    seedSessionWithDashboard(ds, 'fit', {
      data: { fitRunSummary: [{ score: 92, passed: true }] },
      tabs: [
        {
          id: 'fit-run-summary',
          title: 'Fitness — Latest Run',
          order: 0,
          dataKey: 'fitRunSummary',
          view: {
            kind: 'cards',
            fields: [{ key: 'score', label: 'Score', format: 'number' }],
          },
        },
      ],
    });

    const scope = makeScope([makeTool('fitness')], ds);
    const result = await runWithScope(scope, () => composeAndWriteReport({ open: false }));
    const html = readFileSync(result.path, 'utf8');

    // The tab is namespaced by the producing tool id: contrib-<tool>-<tabId>.
    expect(html).toContain('data-tab="contrib-fit-fit-run-summary"');
    expect(html).toContain('id="panel-contrib-fit-fit-run-summary"');
    expect(html).toContain('Fitness — Latest Run');
    // The contribution's resolved inline row data is inlined.
    expect(html).toContain('renderContributedCards');
  });

  it('ignores a reserved host key (contributedTabs) from collectReportData', async () => {
    vi.spyOn(openReportMod, 'launchReport').mockResolvedValue(true);
    // A misbehaving tool tries to inject its own contributedTabs via the
    // report-data path — it must be stripped before merge (warn + drop).
    const evil = makeTool('evil', {
      contributedTabs: [
        { id: 'contrib-evil-injected', title: 'Injected', order: 0, view: {}, rows: [] },
      ],
      sessions: [{ id: 'forged' }],
      checkCatalog: [{ slug: 'legit' }],
    });

    const scope = makeScope([evil], ds);
    const result = await runWithScope(scope, () => composeAndWriteReport({ open: false }));
    const html = readFileSync(result.path, 'utf8');

    // The forged tab + forged session never reach the input; the legit catalog does.
    expect(html).not.toContain('contrib-evil-injected');
    expect(html).not.toContain('forged');
    expect(html).toContain('legit');
  });

  it('drops a duplicate contributed tab id within one report (warn + drop)', async () => {
    vi.spyOn(openReportMod, 'launchReport').mockResolvedValue(true);
    // Two sessions for the SAME tool, each contributing a tab with the SAME id
    // ⇒ the namespaced id collides; the second is dropped, not duplicated.
    const repo = new SessionRepo(ds);
    const dash: ToolDashboardContribution = {
      data: { fitRunSummary: [{ score: 1 }] },
      tabs: [
        {
          id: 'fit-run-summary',
          title: 'Fitness — Latest Run',
          order: 0,
          dataKey: 'fitRunSummary',
          view: { kind: 'cards', fields: [{ key: 'score', label: 'Score' }] },
        },
      ],
    };
    for (const n of ['a', 'b']) {
      const id = `fit-sess-${n}`;
      repo.save({
        id,
        tool: 'fit',
        startedAt: '2026-06-14T10:00:00.000Z',
        completedAt: '2026-06-14T10:00:01.000Z',
        cwd: projectRoot,
        score: 100,
        passed: true,
        durationMs: 1,
      });
      repo.saveDashboardContribution(id, 'fit', dash);
    }

    const scope = makeScope([makeTool('fitness')], ds);
    const result = await runWithScope(scope, () => composeAndWriteReport({ open: false }));
    const html = readFileSync(result.path, 'utf8');

    // The namespaced id appears for exactly one panel button + one panel div
    // (data-tab + panel-) — not duplicated by the second session's same-id tab.
    const buttonMatches = html.match(/data-tab="contrib-fit-fit-run-summary"/g) ?? [];
    const panelMatches = html.match(/id="panel-contrib-fit-fit-run-summary"/g) ?? [];
    expect(buttonMatches).toHaveLength(1);
    expect(panelMatches).toHaveLength(1);
  });
});

describe('composeAndWriteReport — durable contributions survive a fresh process (Phase 8)', () => {
  it('hydrates contributed tabs from a CLOSED + REOPENED sqlite datastore (not same-process memory)', async () => {
    vi.spyOn(openReportMod, 'launchReport').mockResolvedValue(true);
    const dbPath = join(projectRoot, 'fresh-process.sqlite');

    // "Run process": persist a session + its dashboard contribution, then CLOSE
    // the datastore entirely (drop all in-memory state).
    const writer = DataStoreFactory.open({ backend: 'sqlite', path: dbPath });
    seedSessionWithDashboard(writer, 'graph', {
      data: { graphRunSummary: [{ functions: 42 }] },
      tabs: [
        {
          id: 'graph-run',
          title: 'Code Paths — Latest Run',
          order: 1,
          dataKey: 'graphRunSummary',
          view: {
            kind: 'cards',
            fields: [{ key: 'functions', label: 'Functions', format: 'number' }],
          },
        },
      ],
    });
    writer.close();

    // "report process": a BRAND-NEW DataStore on the same file — proves the
    // contribution is read back from disk by session id, with zero reliance on
    // the original run's in-memory state (host-owned-run-timing §11 #7).
    const reader = DataStoreFactory.open({ backend: 'sqlite', path: dbPath });
    try {
      const scope = makeScope([makeTool('graph')], reader);
      const result = await runWithScope(scope, () => composeAndWriteReport({ open: false }));
      const html = readFileSync(result.path, 'utf8');
      expect(html).toContain('data-tab="contrib-graph-graph-run"');
      expect(html).toContain('Code Paths — Latest Run');
    } finally {
      reader.close();
    }
  });
});
