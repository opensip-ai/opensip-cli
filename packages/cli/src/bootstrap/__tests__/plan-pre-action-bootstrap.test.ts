/**
 * Table-driven bootstrap planner + post-bailout phase-order tests (ADR-0052).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LanguageRegistry,
  ToolRegistry,
  type Tool,
  type ToolPluginManifest,
  type ToolProvenance,
} from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { BootstrapError } from '../bootstrap-error.js';
import { executePostBailoutBootstrap } from '../execute-post-bailout-bootstrap.js';
import { planPreActionBootstrap } from '../plan-pre-action-bootstrap.js';
import { POST_BAILOUT_PHASE_ORDER, PRE_ACTION_PHASES } from '../pre-action-bootstrap-phases.js';

import type { PreActionRuntime } from '../pre-action-runtime.js';

const noopTool = (name: string, scope?: 'project' | 'none'): Tool => ({
  metadata: { id: name, name, version: '0', description: name },
  commands: [{ name, description: name, scope }],
  commandSpecs: [],
});

function runtimeWith(tools: Tool[]): PreActionRuntime {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  return {
    languages: new LanguageRegistry(),
    tools: registry,
    manifests: [] as ToolPluginManifest[],
    provenance: [] as ToolProvenance[],
  };
}

describe('planPreActionBootstrap', () => {
  it('schema-version bailout completes through bailout-window only', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-plan-'));
    writeFileSync(join(tmp, 'opensip-cli.config.yml'), 'schemaVersion: 99\ntargets: {}\n', 'utf8');
    expect(() =>
      planPreActionBootstrap({
        opts: {},
        cwd: tmp,
        cwdExplicit: false,
        runId: 'RUN_test',
        commandName: 'fit-list',
        tools: new ToolRegistry(),
      }),
    ).toThrow(BootstrapError);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('no-project bailout for project-scoped command', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-plan-'));
    expect(() =>
      planPreActionBootstrap({
        opts: {},
        cwd: tmp,
        cwdExplicit: false,
        runId: 'RUN_test',
        commandName: 'fit',
        tools: new ToolRegistry(),
      }),
    ).toThrow(BootstrapError);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('agnostic command pass-through when no project', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-plan-'));
    const plan = planPreActionBootstrap({
      opts: {},
      cwd: tmp,
      cwdExplicit: false,
      runId: 'RUN_test',
      commandName: 'init',
      tools: new ToolRegistry(),
    });
    expect(plan.completedThrough).toBe(PRE_ACTION_PHASES.bailoutWindow);
    expect(plan.project.scope).toBe('none');
    rmSync(tmp, { recursive: true, force: true });
  });

  it('tool scope:none commands are agnostic', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-plan-'));
    const tools = new ToolRegistry();
    tools.register(noopTool('configure', 'none'));
    const plan = planPreActionBootstrap({
      opts: {},
      cwd: tmp,
      cwdExplicit: false,
      runId: 'RUN_test',
      commandName: 'configure',
      tools,
    });
    expect(plan.project.scope).toBe('none');
    expect(plan.completedThrough).toBe(PRE_ACTION_PHASES.bailoutWindow);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('normal project run produces runLoggerOptions with logDir', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-plan-'));
    writeFileSync(join(tmp, 'opensip-cli.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
    const plan = planPreActionBootstrap({
      opts: {},
      cwd: tmp,
      cwdExplicit: false,
      runId: 'RUN_test',
      commandName: 'fit-list',
      tools: new ToolRegistry(),
    });
    expect(plan.project.scope).toBe('project');
    expect(plan.runLoggerOptions.runId).toBe('RUN_test');
    expect(plan.runLoggerOptions.logDir).toContain('opensip-cli/.runtime/logs');
    rmSync(tmp, { recursive: true, force: true });
  });

  it('strict --config miss throws BootstrapError', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-plan-'));
    expect(() =>
      planPreActionBootstrap({
        opts: {},
        cwd: tmp,
        cwdExplicit: false,
        runId: 'RUN_test',
        commandName: 'fit',
        explicitConfigPath: join(tmp, 'missing.yml'),
        tools: new ToolRegistry(),
      }),
    ).toThrow(BootstrapError);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('executePostBailoutBootstrap phase ordering', () => {
  it('records post-bailout phases in ADR-0052 order', async () => {
    const phases: string[] = [];

    const plan = planPreActionBootstrap({
      opts: {},
      cwd: process.cwd(),
      cwdExplicit: false,
      runId: 'RUN_order',
      commandName: 'init',
      tools: new ToolRegistry(),
    });

    await executePostBailoutBootstrap(
      {
        plan,
        runtime: runtimeWith([]),
        version: '0.0.0-test',
        noCloud: true,
      },
      {
        recordPhase: (p) => phases.push(p),
        enterScope: () => undefined,
        isScopeEntered: () => true,
        checkForUpdate: () => undefined,
        startProfiling: () => undefined,
        maybeInitializeOwningTool: () => Promise.resolve(),
        loadOwningToolCapabilities: () => Promise.resolve(0),
      },
    );

    expect(phases).toEqual([...POST_BAILOUT_PHASE_ORDER]);
  });

  it('builds a real project RunScope before tool preflight', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-post-'));
    writeFileSync(join(tmp, 'opensip-cli.config.yml'), 'schemaVersion: 1\ntargets: {}\n', 'utf8');
    const tool = {
      ...noopTool('scoped-tool'),
      contributeScope: () => ({ scopedTool: { ready: true } }),
    } satisfies Tool;
    const runtime = runtimeWith([tool]);
    const plan = planPreActionBootstrap({
      opts: {},
      cwd: tmp,
      cwdExplicit: false,
      runId: 'RUN_scope',
      commandName: 'fit-list',
      tools: runtime.tools,
    });

    const result = await executePostBailoutBootstrap(
      {
        plan,
        runtime,
        version: '0.0.0-test',
        noCloud: true,
      },
      {
        enterScope: () => undefined,
        isScopeEntered: () => true,
        checkForUpdate: () => undefined,
        startProfiling: () => undefined,
        maybeInitializeOwningTool: () => Promise.resolve(),
        loadOwningToolCapabilities: () => Promise.resolve(0),
      },
    );

    expect(result.scope.runId).toBe('RUN_scope');
    expect(result.scope.projectContext?.scope).toBe('project');
    expect(result.scope.configDocument).toBeDefined();
    expect((result.scope as unknown as { scopedTool?: { ready: boolean } }).scopedTool?.ready).toBe(
      true,
    );
    rmSync(tmp, { recursive: true, force: true });
  });

  it.each([
    {
      label: 'schema-version',
      writeConfig: (dir: string) =>
        writeFileSync(join(dir, 'opensip-cli.config.yml'), 'schemaVersion: 99\ntargets: {}\n'),
      commandName: 'fit-list',
    },
    {
      label: 'no-project',
      writeConfig: () => undefined,
      commandName: 'fit',
    },
  ])('planner bailout stops before post-bailout phase: $label', ({ writeConfig, commandName }) => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-bail-'));
    writeConfig(tmp);

    expect(() =>
      planPreActionBootstrap({
        opts: {},
        cwd: tmp,
        cwdExplicit: false,
        runId: 'RUN_bail',
        commandName,
        tools: new ToolRegistry(),
      }),
    ).toThrow(BootstrapError);

    rmSync(tmp, { recursive: true, force: true });
  });
});
