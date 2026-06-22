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
import { type DataStore } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as openReportMod from '../open-report.js';
import { composeAndWriteReport } from '../report-compose.js';

import type { ProjectContext, Tool, ToolProvenance, ToolScope } from '@opensip-cli/core';

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
    metadata: { id, name: id, version: '0.0.0', description: id },
    commandSpecs: [],
    ...(contribution
      ? { extensionPoints: { collectReportData: (_scope: ToolScope) => contribution } }
      : {}),
  };
}

function makeScope(
  tools: Tool[],
  datastore?: DataStore,
  toolProvenance: readonly ToolProvenance[] = [],
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

  it('ADR-0054 M4-F: does NOT run an EXTERNAL tool collectReportData in-host (forks a worker; a fork failure is best-effort)', async () => {
    vi.spyOn(openReportMod, 'launchReport').mockResolvedValue(true);
    // A tool whose collectReportData would THROW if the host ran it in-process —
    // proving the host does NOT execute it: the external branch forks a worker
    // instead (which fails here, since the test process is not the CLI binary), is
    // caught best-effort, and the report still renders for the bundled tool.
    const external: Tool = {
      metadata: { id: 'ext-tool', name: 'ext-tool', version: '0.0.0', description: 'ext' },
      commandSpecs: [],
      extensionPoints: {
        collectReportData: () => {
          throw new Error('external collectReportData must NOT run in-host');
        },
      },
    };
    const bundled = makeTool('fitness', { checkCatalog: [{ slug: 'legit' }] });
    const provenance: ToolProvenance[] = [
      { source: 'installed', id: 'ext-tool', version: '0.0.0', manifestHash: 'h' },
    ];

    const scope = makeScope([external, bundled], undefined, provenance);
    // No throw — the external hook never ran in-host (it would have thrown);
    // the bundled tool's contribution still merges.
    const result = await runWithScope(scope, () => composeAndWriteReport({ open: false }));
    const html = readFileSync(result.path, 'utf8');
    expect(html).toContain('legit');
  });

  it('ignores a reserved host key (`sessions`) returned from collectReportData', async () => {
    vi.spyOn(openReportMod, 'launchReport').mockResolvedValue(true);
    // A misbehaving tool tries to clobber the host-owned `sessions` history via
    // collectReportData — it must be stripped before merge (warn + drop). Its
    // legitimate (non-reserved) catalog still merges.
    const evil = makeTool('evil', {
      sessions: [{ id: 'forged' }],
      checkCatalog: [{ slug: 'legit' }],
    });

    const scope = makeScope([evil]);
    const result = await runWithScope(scope, () => composeAndWriteReport({ open: false }));
    const html = readFileSync(result.path, 'utf8');

    expect(html).not.toContain('forged');
    expect(html).toContain('legit');
  });
});
