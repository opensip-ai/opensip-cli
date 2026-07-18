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
import { RunRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as dispatchHookMod from '../bootstrap/dispatch-external-tool-hook.js';
import * as openReportMod from '../open-report.js';
import { composeAndWriteReport } from '../report-compose.js';

import type { StoredRun } from '@opensip-cli/contracts';
import type { ProjectContext, Tool, ToolProvenance, ToolScope } from '@opensip-cli/core';

let projectRoot: string;
const openDatastores: DataStore[] = [];

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'opensip-dash-compose-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const datastore of openDatastores.splice(0)) datastore.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

function openMemoryDatastore(): DataStore {
  const datastore = DataStoreFactory.open({ backend: 'memory' });
  openDatastores.push(datastore);
  return datastore;
}

function storedRun(id = 'run-parent-1'): StoredRun {
  return {
    id,
    name: 'audit',
    source: 'built-in-suite',
    cwd: projectRoot,
    startedAt: '2026-07-01T00:00:00.000Z',
    completedAt: '2026-07-01T00:00:01.000Z',
    durationMs: 1000,
    exitCode: 0,
    aggregate: {
      steps: 0,
      passed: 0,
      failed: 0,
      faulted: 0,
      errors: 0,
      warnings: 0,
    },
    legacySuiteRunId: 'suite-1',
  };
}

function makeTool(id: string, contribution?: Record<string, unknown>): Tool {
  return {
    identity: { name: id },
    metadata: { id, name: id, version: '0.0.0', description: id },
    commandSpecs: [],
    ...(contribution
      ? {
          extensionPoints: {
            collectReportData: (_scope: ToolScope) => contribution,
          },
        }
      : {}),
  };
}

function makeScope(
  tools: Tool[],
  datastore?: DataStore,
  toolProvenance: readonly ToolProvenance[] = [],
  logger?: RunScope['logger'],
): RunScope {
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
    toolProvenance,
    ...(logger === undefined ? {} : { logger }),
    ...(datastore ? { datastore: () => datastore } : {}),
  });
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
    expect(result).toEqual({
      type: 'report',
      path: expectedPath,
      opened: false,
    });

    const html = readFileSync(expectedPath, 'utf8');
    // Cross-tool panels are present.
    expect(html).toContain('id="panel-fitness"');
    expect(html).toContain('id="panel-simulation"');
    // Fitness's catalog contribution made it into the inlined data.
    expect(html).toContain('demo-check');
  });

  it('omits an external contribution when the forked hook rejects', async () => {
    vi.spyOn(openReportMod, 'launchReport').mockResolvedValue(true);
    vi.spyOn(dispatchHookMod, 'dispatchExternalToolHook').mockRejectedValue(
      new Error('worker blew up'),
    );

    const external: Tool = {
      identity: { name: 'ext-tool' },
      metadata: {
        id: 'ext-tool',
        name: 'ext-tool',
        version: '0.0.0',
        description: 'ext',
      },
      commandSpecs: [],
      extensionPoints: {
        collectReportData: () => ({ externalOnly: true }),
      },
    };
    const bundled = makeTool('fitness', { checkCatalog: [{ slug: 'legit' }] });
    const provenance: ToolProvenance[] = [
      {
        source: 'installed',
        id: 'ext-tool',
        version: '0.0.0',
        manifestHash: 'h',
      },
    ];

    const scope = makeScope([external, bundled], undefined, provenance);
    const result = await runWithScope(scope, () => composeAndWriteReport({ open: false }));
    const html = readFileSync(result.path, 'utf8');
    expect(html).toContain('legit');
    expect(html).not.toContain('externalOnly');
  });

  it('binds an external report hook RPC context to its owning Tool', async () => {
    vi.spyOn(openReportMod, 'launchReport').mockResolvedValue(true);
    const dispatch = vi
      .spyOn(dispatchHookMod, 'dispatchExternalToolHook')
      .mockImplementation(async (args) => {
        await args.ctx.toolState.put('victim-tool', 'stolen', true);
        return { externalOnly: true };
      });
    const external = makeTool('ext-tool', { externalOnly: true });
    const scope = makeScope([external], undefined, [
      {
        source: 'installed',
        id: 'ext-tool',
        version: '0.0.0',
        manifestHash: 'h',
      },
    ]);

    const result = await runWithScope(scope, () => composeAndWriteReport({ open: false }));
    expect(dispatch).toHaveBeenCalledOnce();
    expect(readFileSync(result.path, 'utf8')).not.toContain('externalOnly');
    const dispatchedCtx = dispatch.mock.calls[0]?.[0].ctx;
    expect(() => dispatchedCtx?.toolState.put('victim-tool', 'stolen', true)).toThrow(
      /namespace 'victim-tool'/,
    );
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

  it('embeds and launches a matching stored-run selection on a run-addressed path', async () => {
    const launch = vi.spyOn(openReportMod, 'launchReport').mockResolvedValue(true);
    const info = vi.fn();
    const datastore = openMemoryDatastore();
    new RunRepo(datastore).saveRun(storedRun());
    const scope = makeScope([makeTool('fitness')], datastore, [], {
      debug: vi.fn(),
      info,
      warn: vi.fn(),
      error: vi.fn(),
    });

    const result = await runWithScope(scope, () =>
      composeAndWriteReport({
        open: true,
        selection: { view: 'change-impact', runId: 'run-parent-1' },
      }),
    );

    const reportsDir = resolveProjectPaths(projectRoot).reportsDir;
    expect(result.path).toMatch(new RegExp(`${reportsDir}/runs/[a-f0-9]{64}\\.html$`));
    expect(result.path).not.toBe(join(reportsDir, 'latest.html'));
    expect(launch).toHaveBeenCalledWith(`file://${result.path}#change-impact/run-parent-1`);
    expect(readFileSync(result.path, 'utf8')).toContain(
      'const REPORT_SELECTION = {"view":"change-impact","runId":"run-parent-1"};',
    );
    // Convenience alias is refreshed but is not the returned/launch path.
    expect(readFileSync(join(reportsDir, 'latest.html'), 'utf8')).toContain(
      'const REPORT_SELECTION = {"view":"change-impact","runId":"run-parent-1"};',
    );
    expect(info).toHaveBeenCalledWith({
      evt: 'cli.report.compose.selection',
      module: 'cli:report',
      view: 'change-impact',
      hasRunId: true,
      matchedStoredRun: true,
    });
  });

  it('fails closed when an exact retained Run id is not found', async () => {
    const launch = vi.spyOn(openReportMod, 'launchReport').mockResolvedValue(true);
    const info = vi.fn();
    const datastore = openMemoryDatastore();
    new RunRepo(datastore).saveRun(storedRun());
    const scope = makeScope([], datastore, [], {
      debug: vi.fn(),
      info,
      warn: vi.fn(),
      error: vi.fn(),
    });

    await expect(
      runWithScope(scope, () =>
        composeAndWriteReport({
          open: true,
          selection: { view: 'change-impact', runId: 'run-missing' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFIGURATION.REPORT.RUN_NOT_FOUND' });
    expect(launch).not.toHaveBeenCalled();
  });

  it('omits malformed or oversized run identity text before embedding and launch', async () => {
    const launch = vi.spyOn(openReportMod, 'launchReport').mockResolvedValue(true);
    const scope = makeScope([]);
    const maliciousRunId = `${'a'.repeat(129)}/#fragment`;

    const result = await runWithScope(scope, () =>
      composeAndWriteReport({
        open: true,
        selection: { view: 'change-impact', runId: maliciousRunId },
      }),
    );

    expect(launch).toHaveBeenCalledWith(`file://${result.path}#change-impact`);
    const html = readFileSync(result.path, 'utf8');
    expect(html).not.toContain(maliciousRunId);
    expect(html).toContain('const REPORT_SELECTION = {"view":"change-impact"};');
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

  it('ADR-0054 M4-F: does NOT run an EXTERNAL tool collectReportData in-host (forks a worker; a fork failure is best-effort)', async () => {
    vi.spyOn(openReportMod, 'launchReport').mockResolvedValue(true);
    // A tool whose collectReportData would THROW if the host ran it in-process —
    // proving the host does NOT execute it: the external branch forks a worker
    // instead (which fails here, since the test process is not the CLI binary), is
    // caught best-effort, and the report still renders for the bundled tool.
    const external: Tool = {
      identity: { name: 'ext-tool' },
      metadata: {
        id: 'ext-tool',
        name: 'ext-tool',
        version: '0.0.0',
        description: 'ext',
      },
      commandSpecs: [],
      extensionPoints: {
        collectReportData: () => {
          throw new Error('external collectReportData must NOT run in-host');
        },
      },
    };
    const bundled = makeTool('fitness', { checkCatalog: [{ slug: 'legit' }] });
    const provenance: ToolProvenance[] = [
      {
        source: 'installed',
        id: 'ext-tool',
        version: '0.0.0',
        manifestHash: 'h',
      },
    ];

    const scope = makeScope([external, bundled], undefined, provenance);
    // No throw — the external hook never ran in-host (it would have thrown);
    // the bundled tool's contribution still merges.
    const result = await runWithScope(scope, () => composeAndWriteReport({ open: false }));
    const html = readFileSync(result.path, 'utf8');
    expect(html).toContain('legit');
  });

  it('ignores host-owned sessions, runs, and selection returned from collectReportData', async () => {
    vi.spyOn(openReportMod, 'launchReport').mockResolvedValue(true);
    // A misbehaving tool tries to clobber host evidence/navigation via
    // collectReportData. Reserved keys are stripped while its legitimate catalog
    // contribution still merges.
    const evil = makeTool('evil', {
      sessions: [{ id: 'forged-session' }],
      runs: [{ id: 'forged-run' }],
      selection: { view: 'change-impact', runId: 'forged-selection' },
      checkCatalog: [{ slug: 'legit' }],
    });

    const scope = makeScope([evil]);
    const result = await runWithScope(scope, () => composeAndWriteReport({ open: false }));
    const html = readFileSync(result.path, 'utf8');

    expect(html).not.toContain('forged-session');
    expect(html).not.toContain('forged-run');
    expect(html).not.toContain('forged-selection');
    expect(html).toContain('legit');
  });

  it('rejects prototype-mutating contribution keys without inheriting report selection', async () => {
    const warn = vi.fn();
    const contribution = JSON.parse(
      '{"__proto__":{"selection":{"view":"change-impact","runId":"forged-prototype"}},"checkCatalog":[{"slug":"legit"}]}',
    ) as Record<string, unknown>;
    const scope = makeScope([makeTool('evil-prototype', contribution)], undefined, [], {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    });

    const result = await runWithScope(scope, () => composeAndWriteReport({ open: false }));
    const html = readFileSync(result.path, 'utf8');

    expect(html).not.toContain('forged-prototype');
    expect(html).toContain('const REPORT_SELECTION = null;');
    expect(html).toContain('legit');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.report.compose.reserved_key_ignored',
        keys: ['__proto__'],
      }),
    );
  });

  it('warns and keeps the first value when two tools contribute the same report key', async () => {
    vi.spyOn(openReportMod, 'launchReport').mockResolvedValue(true);
    const warn = vi.fn();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    };
    const scope = makeScope(
      [
        makeTool('first-tool', { checkCatalog: [{ slug: 'first-writer' }] }),
        makeTool('second-tool', { checkCatalog: [{ slug: 'second-writer' }] }),
      ],
      undefined,
      [],
      logger,
    );

    const result = await runWithScope(scope, () => composeAndWriteReport({ open: false }));
    const html = readFileSync(result.path, 'utf8');

    expect(html).toContain('first-writer');
    expect(html).not.toContain('second-writer');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.report.compose.collision',
        tool: 'second-tool',
        otherTool: 'first-tool',
        key: 'checkCatalog',
      }),
    );
  });
});
