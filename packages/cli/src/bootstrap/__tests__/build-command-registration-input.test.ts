import { logger, ToolRegistry } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { buildCommandRegistrationInput } from '../build-command-registration-input.js';

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
    expect([...input.toolInternalCommands]).toEqual(['fit-run-worker']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when expected bundled scaffolding tools are absent', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const input = buildCommandRegistrationInput(new ToolRegistry());

    expect(input.pluginLayouts).toEqual([]);
    expect(input.toolScaffolds).toEqual([]);
    expect(input.toolCommandSpecs).toEqual([]);
    expect([...input.toolInternalCommands]).toEqual([]);
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
});
