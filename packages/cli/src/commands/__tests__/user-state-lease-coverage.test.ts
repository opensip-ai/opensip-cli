/**
 * Inventory: every host path that mutates user-root or global Tool/plugin
 * state must declare HostSpec runtimeAccess. Tool specs cannot forge policy.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LanguageRegistry,
  RunScope,
  runWithScopeSync,
  ToolRegistry,
  type CommandSpec,
} from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { BUNDLED_TOOLS } from '../../__tests__/test-utils/bundled-tools.js';
import { buildCommandScopeIndex } from '../command-scope-index.js';
import { buildTopLevelHostSpecs } from '../host-command-specs.js';
import {
  assertEnteredProjectOwner,
  assertEnteredUserStateOwner,
  defineHostCommand,
  resetEnteredHostOwnershipForTests,
  resolveHostRuntimePolicy,
} from '../host-runtime-access.js';
import { buildHostSubcommandGroups } from '../host-subcommand-groups.js';

import type { CliCommandsContext } from '../shared.js';

function makeCtx(tools: ToolRegistry): CliCommandsContext {
  return {
    setExitCode: vi.fn(),
    getExitCode: vi.fn(),
    render: vi.fn(() => Promise.resolve()),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    emitError: vi.fn(),
    pluginLayouts: [],
    toolScaffolds: [],
    datastore: vi.fn(),
    tools,
    toolContext: {} as CliCommandsContext['toolContext'],
    toolRunActionHooks: {},
  };
}

describe('user-state lease coverage inventory', () => {
  it('declares configure as user-state and tools install/uninstall as project-and-user-state', () => {
    const tools = new ToolRegistry();
    for (const tool of BUNDLED_TOOLS) tools.register(tool);
    const scope = new RunScope({ tools, languages: new LanguageRegistry() });

    runWithScopeSync(scope, () => {
      const ctx = makeCtx(tools);
      const index = buildCommandScopeIndex({
        toolSpecs: BUNDLED_TOOLS.flatMap((tool) => [...(tool.commandSpecs ?? [])]),
        hostSpecs: buildTopLevelHostSpecs(ctx),
        hostGroups: [...buildHostSubcommandGroups(ctx)],
      });

      const configure = index.get('configure');
      expect(configure).toBeDefined();
      expect(configure!.runtimePolicy.runtimeAccess).toBe('user-state');
      expect(configure!.scope).toBe('none');

      const toolsInstall = index.get('tools install');
      expect(toolsInstall).toBeDefined();
      expect(toolsInstall!.runtimePolicy.runtimeAccess).toBe('project-and-user-state');
      expect(toolsInstall!.scope).toBe('none');

      const toolsUninstall = index.get('tools uninstall');
      expect(toolsUninstall).toBeDefined();
      expect(toolsUninstall!.runtimePolicy.runtimeAccess).toBe('project-and-user-state');
      expect(toolsUninstall!.scope).toBe('none');
    });
  });

  it('never indexes Tool-forged hostRuntimePolicy into the private inventory', () => {
    const forged = {
      name: 'forged-tool-cmd',
      description: 'should not carry host policy',
      commonFlags: [],
      scope: 'none',
      output: 'command-result',
      handler: () => undefined,
      // Tool authors cannot pass hostRuntimePolicy through core defineCommand.
      hostRuntimePolicy: { runtimeAccess: 'user-state', bootstrapMode: 'standard' },
    } as CommandSpec<unknown, unknown> & {
      hostRuntimePolicy: { runtimeAccess: string; bootstrapMode: string };
    };

    const index = buildCommandScopeIndex({
      toolSpecs: [forged],
      hostSpecs: [],
      hostGroups: [],
    });
    const entry = index.get('forged-tool-cmd');
    expect(entry).toBeDefined();
    // Tools always receive the default policy — private host decoration is ignored.
    expect(entry!.runtimePolicy).toEqual({
      runtimeAccess: 'default',
      bootstrapMode: 'standard',
    });
  });

  it('keeps hostRuntimePolicy off public catalog-facing host names used by agents', () => {
    const tools = new ToolRegistry();
    for (const tool of BUNDLED_TOOLS) tools.register(tool);
    const scope = new RunScope({ tools, languages: new LanguageRegistry() });
    runWithScopeSync(scope, () => {
      const ctx = makeCtx(tools);
      const specs = buildTopLevelHostSpecs(ctx);
      for (const spec of specs) {
        // The decorated field is CLI-private; agent-catalog consumers must not
        // require it. resolveHostRuntimePolicy still works for bootstrap.
        const policy = resolveHostRuntimePolicy(
          (spec as { hostRuntimePolicy?: Parameters<typeof resolveHostRuntimePolicy>[0] })
            .hostRuntimePolicy,
        );
        expect(policy).toBeDefined();
        expect(Object.isFrozen(policy)).toBe(true);
      }
    });
  });

  it('fails direct user/project mutation without entered ownership before I/O', () => {
    resetEnteredHostOwnershipForTests();
    expect(() => assertEnteredUserStateOwner('test-user-write')).toThrow(
      /requires an entered user-state runtime lease/,
    );
    expect(() => assertEnteredProjectOwner('test-project-write')).toThrow(
      /requires an entered project runtime lease/,
    );
  });

  it('classifies trust and update-state writers as user-state requiring ownership', async () => {
    resetEnteredHostOwnershipForTests();
    const privateTemp = mkdtempSync(join(tmpdir(), 'opensip-user-state-lease-'));
    const updateStatePath = join(privateTemp, 'no-write-update-state.json');
    const installSourcePath = join(privateTemp, 'install-source');
    const { writeKnownLatest, clearKnownLatest } = await import('../../update-state.js');
    const { recordInstalledToolTrust } = await import('../../bootstrap/tool-trust.js');
    try {
      expect(() => writeKnownLatest('1.0.0', updateStatePath)).toThrow(/user-state runtime lease/);
      expect(() => clearKnownLatest(updateStatePath)).toThrow(/user-state runtime lease/);
      expect(() =>
        recordInstalledToolTrust({
          scope: 'global',
          cwd: privateTemp,
          toolId: 'x',
          packageName: 'x',
          manifestHash: 'h',
          installSourcePath,
        }),
      ).toThrow(/user-state runtime lease/);
      expect(() =>
        recordInstalledToolTrust({
          scope: 'project',
          cwd: privateTemp,
          toolId: 'x',
          packageName: 'x',
          manifestHash: 'h',
          installSourcePath,
        }),
      ).toThrow(/project runtime lease/);
    } finally {
      rmSync(privateTemp, { recursive: true, force: true });
    }
  });

  it('freezes decorated host policy so inventory copies cannot be mutated', () => {
    const decorated = defineHostCommand(
      {
        name: 'configure-like',
        description: 'fixture',
        commonFlags: [],
        scope: 'none',
        output: 'command-result',
        handler: () => undefined,
      },
      { runtimeAccess: 'user-state' },
    );
    expect(Object.isFrozen(decorated.hostRuntimePolicy)).toBe(true);
    expect(() => {
      (decorated.hostRuntimePolicy as { runtimeAccess: string }).runtimeAccess = 'default';
    }).toThrow();
  });
});
