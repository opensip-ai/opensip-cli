/**
 * ADR-0159 reserved-name guards.
 *
 * 1. Admission: a Tool claiming ANY host-reserved root (name, alias, or
 *    `parent`) is rejected by `rejectHostCommandCollisions` — not just `audit`.
 * 2. Parity: `HOST_RESERVED_ROOT_COMMANDS` equals the actually-mounted host
 *    command surface (every root name + alias `registerCliCommands` mounts,
 *    plus Commander's implicit `help`). Adding/renaming a host command without
 *    updating the reserved list fails here, and vice versa.
 * 3. Suite plane: every built-in suite name is reserved in
 *    `@opensip-cli/config`, so the config document can never define a
 *    configured suite that shadows a built-in one.
 */
import { RESERVED_SUITE_NAMES } from '@opensip-cli/config';
import {
  defineCommand,
  LanguageRegistry,
  RunScope,
  runWithScopeSync,
  ToolRegistry,
  type Tool,
} from '@opensip-cli/core';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { rejectHostCommandCollisions } from '../bootstrap/reject-host-command-collisions.js';
import { HOST_RESERVED_ROOT_COMMANDS } from '../bootstrap/reserved-names.js';
import { registerCliCommands } from '../commands/index.js';
import {
  BUILT_IN_AGENT_CONTEXT_SUITE_NAME,
  BUILT_IN_AUDIT_SUITE_NAME,
} from '../commands/suite/built-in-suites.js';

const noopHandler = (): { type: 'text-lines'; lines: string[] } => ({
  type: 'text-lines',
  lines: [],
});

function fixtureTool(
  name: string,
  spec: { readonly root?: string; readonly aliases?: readonly string[]; readonly parent?: string },
): Tool {
  return {
    identity: { name },
    metadata: {
      id: `00000000-0000-4000-8000-${String(name.length).padStart(12, '0')}`,
      name,
      version: '0.0.0',
      description: `${name} fixture`,
    },
    commands: [],
    commandSpecs: [
      defineCommand({
        name: spec.root ?? name,
        ...(spec.aliases === undefined ? {} : { aliases: spec.aliases }),
        ...(spec.parent === undefined ? {} : { parent: spec.parent }),
        description: `${name} fixture command`,
        commonFlags: ['json'],
        scope: 'project',
        output: 'command-result',
        handler: noopHandler,
      }),
    ],
  };
}

/** Mount ONLY the host-owned commands (no tools) and collect root names + aliases. */
function mountedHostRootNames(): ReadonlySet<string> {
  const scope = new RunScope({
    languages: new LanguageRegistry(),
    tools: new ToolRegistry(),
  });
  return runWithScopeSync(scope, () => {
    const program = new Command('opensip');
    registerCliCommands(program, {
      setExitCode: vi.fn(),
      render: vi.fn(() => Promise.resolve()),
      emitJson: vi.fn(),
      emitRaw: vi.fn(),
      emitError: vi.fn(),
      datastore: () => undefined,
      pluginLayouts: [],
      toolScaffolds: [],
      tools: new ToolRegistry(),
    });
    return new Set(program.commands.flatMap((command) => [command.name(), ...command.aliases()]));
  });
}

describe('host-reserved root commands (ADR-0159)', () => {
  it('rejects a Tool that claims a non-audit host root command', () => {
    const tools = new ToolRegistry();
    tools.register(fixtureTool('shadow-init', { root: 'init' }));

    expect(rejectHostCommandCollisions(tools)).toEqual(['shadow-init']);
    expect(tools.get('shadow-init')).toBeUndefined();
  });

  it('rejects a Tool that claims a host root through an alias', () => {
    const tools = new ToolRegistry();
    tools.register(fixtureTool('aliased', { root: 'aliased', aliases: ['report'] }));

    expect(rejectHostCommandCollisions(tools)).toEqual(['aliased']);
  });

  it('rejects a Tool that mounts a child under a host root', () => {
    const tools = new ToolRegistry();
    tools.register(fixtureTool('nested', { root: 'extra', parent: 'sessions' }));

    expect(rejectHostCommandCollisions(tools)).toEqual(['nested']);
  });

  it('keeps Tools that claim their own non-reserved root', () => {
    const tools = new ToolRegistry();
    tools.register(fixtureTool('lint', { root: 'lint' }));

    expect(rejectHostCommandCollisions(tools)).toEqual([]);
    expect(tools.get('lint')).toBeDefined();
  });

  it('stays in parity with the mounted host command surface', () => {
    // `help` is Commander's implicit built-in; it never appears in
    // program.commands but still occupies the root name.
    const expected = new Set([...mountedHostRootNames(), 'help']);
    expect([...HOST_RESERVED_ROOT_COMMANDS].sort()).toEqual([...expected].sort());
  });
});

describe('reserved suite names (ADR-0159)', () => {
  it('reserves every built-in suite name', () => {
    expect(RESERVED_SUITE_NAMES).toEqual([
      BUILT_IN_AUDIT_SUITE_NAME,
      BUILT_IN_AGENT_CONTEXT_SUITE_NAME,
    ]);
  });
});
