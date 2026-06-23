/**
 * ADR-0052 bailout side-effect guard — post-bailout phases must not run when
 * the planner throws during the bailout window.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineCommand, LanguageRegistry, ToolRegistry } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { buildCommandScopeIndex } from '../../commands/command-scope-index.js';
import { BootstrapError } from '../bootstrap-error.js';
import { executePostBailoutBootstrap } from '../execute-post-bailout-bootstrap.js';
import { planPreActionBootstrap } from '../plan-pre-action-bootstrap.js';

import type { PreActionRuntime } from '../pre-action-runtime.js';

const COMMAND_SCOPES = buildCommandScopeIndex({
  hostSpecs: [
    defineCommand({
      name: 'init',
      description: 'init command',
      commonFlags: [],
      scope: 'none',
      output: 'command-result',
      handler: () => undefined,
    }),
    defineCommand({
      name: 'fit',
      description: 'fit command',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      handler: () => undefined,
    }),
    defineCommand({
      name: 'fit-list',
      description: 'fit-list command',
      commonFlags: [],
      scope: 'project',
      output: 'command-result',
      handler: () => undefined,
    }),
  ],
  hostGroups: [],
  toolSpecs: [],
});

function runtime(): PreActionRuntime {
  return {
    languages: new LanguageRegistry(),
    tools: new ToolRegistry(),
    manifests: [],
    provenance: [],
    bootstrapDiagnostics: [],
  };
}

/**
 * Simulates the pre-action hook sequencing: plan first, post-bailout only on
 * success. Matches packages/cli/src/bootstrap/pre-action-hook.ts.
 */
async function simulatePreActionHook(
  input: Parameters<typeof planPreActionBootstrap>[0],
  deps: Parameters<typeof executePostBailoutBootstrap>[1],
): Promise<'bailout' | 'continued'> {
  try {
    const plan = planPreActionBootstrap(input);
    await executePostBailoutBootstrap(
      {
        plan,
        runtime: runtime(),
        version: '0.0.0-test',
        noCloud: true,
      },
      deps,
    );
    return 'continued';
  } catch (error) {
    if (error instanceof BootstrapError) return 'bailout';
    throw error;
  }
}

describe('bootstrap bailout side effects (ADR-0052)', () => {
  it.each([
    {
      label: 'schema-version mismatch',
      setup: (dir: string) =>
        writeFileSync(join(dir, 'opensip-cli.config.yml'), 'schemaVersion: 99\ntargets: {}\n'),
      commandName: 'fit-list',
    },
    {
      label: 'no-project for project-scoped command',
      setup: () => undefined,
      commandName: 'fit',
    },
  ])('$label: post-bailout deps are never invoked', async ({ setup, commandName }) => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-bailout-'));
    setup(tmp);

    const buildPerRunScope = vi.fn();
    const enterScope = vi.fn();
    const createRunLogger = vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
    const maybeInitializeOwningTool = vi.fn();
    const loadOwningToolCapabilities = vi.fn();

    const outcome = await simulatePreActionHook(
      {
        opts: {},
        cwd: tmp,
        cwdExplicit: false,
        runId: 'RUN_bailout',
        commandName,
        commandPath: commandName,
        commandScopes: COMMAND_SCOPES,
      },
      {
        buildPerRunScope,
        enterScope,
        createRunLogger,
        maybeInitializeOwningTool,
        loadOwningToolCapabilities,
      },
    );

    expect(outcome).toBe('bailout');
    expect(createRunLogger).not.toHaveBeenCalled();
    expect(buildPerRunScope).not.toHaveBeenCalled();
    expect(enterScope).not.toHaveBeenCalled();
    expect(maybeInitializeOwningTool).not.toHaveBeenCalled();
    expect(loadOwningToolCapabilities).not.toHaveBeenCalled();

    rmSync(tmp, { recursive: true, force: true });
  });

  it('successful agnostic plan invokes post-bailout deps', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'opensip-bailout-'));
    const buildPerRunScope = vi.fn();
    const enterScope = vi.fn();
    const createRunLogger = vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }));
    const fakeScope = {
      diagnostics: { event: vi.fn(), counter: vi.fn() },
      configDocument: { plugins: {} },
    };
    buildPerRunScope.mockReturnValue(fakeScope);

    const outcome = await simulatePreActionHook(
      {
        opts: {},
        cwd: tmp,
        cwdExplicit: false,
        runId: 'RUN_ok',
        commandName: 'init',
        commandPath: 'init',
        commandScopes: COMMAND_SCOPES,
      },
      {
        buildPerRunScope,
        enterScope,
        createRunLogger,
        isScopeEntered: () => true,
        maybeInitializeOwningTool: vi.fn(),
        loadOwningToolCapabilities: vi.fn(() => Promise.resolve(0)),
        checkForUpdate: () => undefined,
        startProfiling: () => undefined,
      },
    );

    expect(outcome).toBe('continued');
    expect(createRunLogger).toHaveBeenCalled();
    expect(buildPerRunScope).toHaveBeenCalled();
    expect(enterScope).toHaveBeenCalled();

    rmSync(tmp, { recursive: true, force: true });
  });
});
