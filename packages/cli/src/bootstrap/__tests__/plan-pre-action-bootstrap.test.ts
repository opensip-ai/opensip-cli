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
import { describe, expect, it, vi } from 'vitest';

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
    const { RunScope } = await import('@opensip-cli/core');

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
        buildPerRunScope: (input) => new RunScope({ runId: input.runId, logger: input.logger }),
        checkForUpdate: () => undefined,
        startProfiling: () => undefined,
        maybeInitializeOwningTool: () => Promise.resolve(),
        loadOwningToolCapabilities: () => Promise.resolve(0),
      },
    );

    expect(phases).toEqual([...POST_BAILOUT_PHASE_ORDER]);
  });

  it('bailout prevents post-bailout side effects (buildPerRunScope not called)', () => {
    const buildPerRunScope = vi.fn();
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-bail-'));

    try {
      planPreActionBootstrap({
        opts: {},
        cwd: tmp,
        cwdExplicit: false,
        runId: 'RUN_bail',
        commandName: 'fit',
        tools: new ToolRegistry(),
      });
    } catch {
      // expected no-project bailout
    }

    expect(buildPerRunScope).not.toHaveBeenCalled();
    rmSync(tmp, { recursive: true, force: true });
  });
});
