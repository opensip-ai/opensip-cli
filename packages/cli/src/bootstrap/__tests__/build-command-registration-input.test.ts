import { logger, ToolRegistry } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { enumerateToolScaffolds } from '../../commands/shared.js';
import { buildCommandRegistrationInput } from '../build-command-registration-input.js';
import * as dispatchHookMod from '../dispatch-external-tool-hook.js';

import type { CommandSpec, Tool, ToolCliContext } from '@opensip-cli/core';

function commandSpec(
  name: string,
  visibility?: 'public' | 'internal',
): CommandSpec<unknown, ToolCliContext> {
  return {
    name,
    description: `${name} command`,
    commonFlags: [],
    scope: 'project',
    output: 'command-result',
    ...(visibility === undefined ? {} : { visibility }),
    handler: () => ({ type: 'noop' }),
  };
}

function tool(overrides: {
  readonly name: string;
  readonly id?: string;
  readonly pluginLayout?: Tool['pluginLayout'];
  readonly commandSpecs?: Tool['commandSpecs'];
  readonly extensionPoints?: Tool['extensionPoints'];
}): Tool {
  return {
    identity: { name: overrides.name },
    metadata: {
      id: overrides.id ?? '00000000-0000-4000-8000-000000000000',
      name: overrides.name,
      version: '0.0.0',
      description: `${overrides.name} fixture`,
    },
    commands: [{ name: overrides.name, description: `${overrides.name} command` }],
    ...(overrides.pluginLayout === undefined ? {} : { pluginLayout: overrides.pluginLayout }),
    ...(overrides.commandSpecs === undefined ? {} : { commandSpecs: overrides.commandSpecs }),
    ...(overrides.extensionPoints === undefined
      ? {}
      : { extensionPoints: overrides.extensionPoints }),
  };
}

describe('buildCommandRegistrationInput', () => {
  it('collects registry-derived layouts, scaffolds, replay handlers, specs, and internal names', () => {
    const registry = new ToolRegistry();
    const replaySession = vi.fn(() => ({ type: 'session' }));
    const scaffoldExamples = vi.fn(() => []);
    const stableExampleIds = vi.fn(() => ['fit:example']);
    const scaffoldConfigBlock = vi.fn(() => 'fit: {}');
    const fitRun = commandSpec('fit');
    const fitWorker = commandSpec('fit-run-worker', 'internal');
    const simRecipes = commandSpec('sim recipes');

    registry.register(
      tool({
        name: 'fit',
        id: '00000000-0000-4000-8000-0000000000f1',
        pluginLayout: { domain: 'fit', userSubdirs: ['checks', 'recipes'] },
        commandSpecs: [fitRun, fitWorker],
        extensionPoints: {
          sessionReplay: { tool: 'fit', replaySession },
          scaffoldExamples,
          stableExampleIds,
          scaffoldConfigBlock,
        },
      }),
    );
    registry.register(
      tool({
        name: 'sim',
        id: '00000000-0000-4000-8000-0000000000a1',
        commandSpecs: [simRecipes],
      }),
    );

    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const input = buildCommandRegistrationInput(registry);

    expect(input.pluginLayouts).toEqual([{ domain: 'fit', userSubdirs: ['checks', 'recipes'] }]);
    expect(input.toolScaffolds).toEqual([
      {
        identity: {
          stableId: '00000000-0000-4000-8000-0000000000f1',
          name: 'fit',
          version: '0.0.0',
        },
        layout: { domain: 'fit', userSubdirs: ['checks', 'recipes'] },
        scaffoldExamples,
        stableExampleIds,
        scaffoldConfigBlock,
      },
    ]);
    expect(input.sessionReplayRegistry.get('fit')?.replaySession({} as never)).toEqual({
      type: 'session',
    });
    expect(input.toolCommandSpecs).toEqual([fitRun, fitWorker, simRecipes]);
    // The internal-command set is `HOST_INTERNAL_COMMANDS` (the host-mounted
    // tool and capability workers) unioned with each tool's
    // `visibility:'internal'` command names — the single source completion +
    // help filter on. So host workers are always present, plus the fixture's
    // `fit-run-worker`.
    expect([...input.toolInternalCommands]).toEqual([
      '__tool-command-worker',
      '__capability-pack-worker',
      'fit-run-worker',
    ]);
    expect(warn).not.toHaveBeenCalled();

    const rendered = enumerateToolScaffolds(input.toolScaffolds, {
      languages: ['typescript'],
    });
    expect(rendered).toEqual([
      {
        identity: {
          stableId: '00000000-0000-4000-8000-0000000000f1',
          name: 'fit',
          version: '0.0.0',
        },
        layout: { domain: 'fit', userSubdirs: ['checks', 'recipes'] },
        examples: [],
        stableExampleIds: ['fit:example'],
        configBlock: 'fit: {}',
      },
    ]);
    expect(scaffoldExamples).toHaveBeenCalledOnce();
    expect(stableExampleIds).toHaveBeenCalledOnce();
    expect(scaffoldConfigBlock).toHaveBeenCalledOnce();
  });

  it('rejects duplicate durable identities before evaluating Tool hooks', () => {
    const hook = vi.fn(() => []);
    const shared = {
      identity: { stableId: 'same', name: 'fit', version: '1.0.0' },
      layout: { domain: 'fit', userSubdirs: [] },
      scaffoldExamples: hook,
    } as const;

    expect(() =>
      enumerateToolScaffolds(
        [shared, { ...shared, identity: { ...shared.identity, name: 'sim' } }],
        { languages: [] },
      ),
    ).toThrow(/Duplicate Tool scaffold stable id/);
    expect(hook).not.toHaveBeenCalled();

    expect(() =>
      enumerateToolScaffolds(
        [
          shared,
          {
            ...shared,
            identity: { ...shared.identity, stableId: 'different' },
          },
        ],
        { languages: [] },
      ),
    ).toThrow(/Duplicate Tool scaffold name/);
    expect(hook).not.toHaveBeenCalled();
  });

  it('warns when expected bundled scaffolding tools are absent', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const input = buildCommandRegistrationInput(new ToolRegistry());

    expect(input.pluginLayouts).toEqual([]);
    expect(input.toolScaffolds).toEqual([]);
    expect(input.toolCommandSpecs).toEqual([]);
    // Even with an EMPTY tool registry the host-owned internal commands are
    // always in the set — they are host-mounted, not registry-derived.
    expect([...input.toolInternalCommands]).toEqual([
      '__tool-command-worker',
      '__capability-pack-worker',
    ]);
    expect(input.sessionReplayRegistry.get('fit')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.tool.expected_bundled_absent',
        tool: 'fit',
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'cli.tool.expected_bundled_absent',
        tool: 'sim',
      }),
    );
  });

  it('binds an external session-replay hook RPC context to its owning Tool', async () => {
    const registry = new ToolRegistry();
    registry.register(
      tool({
        name: 'ext',
        id: '00000000-0000-4000-8000-0000000000e1',
        extensionPoints: {
          sessionReplay: { tool: 'ext', replaySession: vi.fn() },
        },
      }),
    );
    const dispatch = vi
      .spyOn(dispatchHookMod, 'dispatchExternalToolHook')
      .mockImplementation(async (args) => {
        await args.ctx.toolState.put('victim-tool', 'stolen', true);
        return { fidelity: 'projection', envelope: {} };
      });
    const input = buildCommandRegistrationInput(registry, {
      cwd: '/repo',
      provenance: [
        {
          source: 'installed',
          id: 'ext',
          stableId: '00000000-0000-4000-8000-0000000000e1',
          version: '0.0.0',
          manifestHash: 'h',
        },
      ],
    });

    await expect(
      input.sessionReplayRegistry.get('ext')?.replaySession({} as never),
    ).rejects.toThrow(/namespace 'victim-tool'/);
    expect(dispatch).toHaveBeenCalledOnce();
    const dispatchedCtx = dispatch.mock.calls[0]?.[0].ctx;
    expect(() => dispatchedCtx?.toolState.put('victim-tool', 'stolen', true)).toThrow(
      /namespace 'victim-tool'/,
    );
  });
});
