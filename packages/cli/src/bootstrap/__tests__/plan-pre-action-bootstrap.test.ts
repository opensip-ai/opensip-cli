/**
 * Table-driven bootstrap planner + post-bailout phase-order tests (ADR-0052).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineCommand,
  LanguageRegistry,
  ToolRegistry,
  type CommandScopeRequirement,
  type CommandSpec,
  type Tool,
  type ToolPluginManifest,
  type ToolProvenance,
} from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { buildCommandScopeIndex } from '../../commands/command-scope-index.js';
import { BootstrapError } from '../bootstrap-error.js';
import { executePostBailoutBootstrap } from '../execute-post-bailout-bootstrap.js';
import { planPreActionBootstrap } from '../plan-pre-action-bootstrap.js';
import { POST_BAILOUT_PHASE_ORDER, PRE_ACTION_PHASES } from '../pre-action-bootstrap-phases.js';

import type { PreActionRuntime } from '../pre-action-runtime.js';

function scopeSpec(name: string, scope: CommandScopeRequirement): CommandSpec {
  return defineCommand({
    name,
    description: `${name} command`,
    commonFlags: [],
    scope,
    output: 'command-result',
    handler: () => undefined,
  });
}

const COMMAND_SCOPES = buildCommandScopeIndex({
  hostSpecs: [
    scopeSpec('init', 'none'),
    scopeSpec('configure', 'none'),
    scopeSpec('completion', 'none'),
    scopeSpec('agent-catalog', 'none'),
    scopeSpec('fit', 'project'),
    scopeSpec('fit-list', 'project'),
  ],
  hostGroups: [
    {
      name: 'tools',
      description: 'Tools group',
      leaves: [scopeSpec('list', 'none'), scopeSpec('data-purge', 'project')],
    },
  ],
  toolSpecs: [],
});

const noopTool = (name: string): Tool => ({
  metadata: { id: name, name, version: '0', description: name },
  commands: [{ name, description: name }],
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
        commandPath: 'fit-list',
        commandScopes: COMMAND_SCOPES,
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
        commandPath: 'fit',
        commandScopes: COMMAND_SCOPES,
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
      commandPath: 'init',
      commandScopes: COMMAND_SCOPES,
    });
    expect(plan.completedThrough).toBe(PRE_ACTION_PHASES.bailoutWindow);
    expect(plan.project.scope).toBe('none');
    rmSync(tmp, { recursive: true, force: true });
  });

  it('scope:none command paths are agnostic', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-plan-'));
    const plan = planPreActionBootstrap({
      opts: {},
      cwd: tmp,
      cwdExplicit: false,
      runId: 'RUN_test',
      commandName: 'list',
      commandPath: 'tools list',
      commandScopes: COMMAND_SCOPES,
    });
    expect(plan.project.scope).toBe('none');
    expect(plan.completedThrough).toBe(PRE_ACTION_PHASES.bailoutWindow);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('scope:project grouped command paths still require a project', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-plan-'));
    expect(() =>
      planPreActionBootstrap({
        opts: {},
        cwd: tmp,
        cwdExplicit: false,
        runId: 'RUN_test',
        commandName: 'data-purge',
        commandPath: 'tools data-purge',
        commandScopes: COMMAND_SCOPES,
      }),
    ).toThrow(BootstrapError);
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
      commandPath: 'fit-list',
      commandScopes: COMMAND_SCOPES,
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
        commandPath: 'fit',
        commandScopes: COMMAND_SCOPES,
        explicitConfigPath: join(tmp, 'missing.yml'),
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
      commandPath: 'init',
      commandScopes: COMMAND_SCOPES,
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
      commandPath: 'fit-list',
      commandScopes: COMMAND_SCOPES,
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
        commandPath: commandName,
        commandScopes: COMMAND_SCOPES,
      }),
    ).toThrow(BootstrapError);

    rmSync(tmp, { recursive: true, force: true });
  });
});
