import {
  createRuntimeCommandInventory,
  defineCommand,
  ToolRegistry,
  ValidationError,
  type RuntimeCommandGroup,
  type RuntimeCommandLeaf,
  type Tool,
} from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import {
  assembleAgentCatalog,
  projectAgentCatalogRuntimeFacts,
} from '../agent-catalog-assembly.js';
import { assertAgentCatalogOverlayKeys, buildAgentCatalog } from '../agent-catalog.js';
import { hostSupportFromRuntimeProjection } from '../host-support.js';

import type { AgentCatalog, AgentHostSupport } from '@opensip-cli/contracts';

const noopHandler = (): { type: 'text-lines'; lines: string[] } => ({
  type: 'text-lines',
  lines: [],
});

function fixtureTool(
  name: string,
  opts: {
    readonly aliases?: readonly string[];
    readonly layoutKey?: string;
    readonly primaryName?: string;
  } = {},
): Tool {
  const primaryName = opts.primaryName ?? name;
  return {
    identity: {
      name,
      ...(opts.aliases === undefined ? {} : { aliases: opts.aliases }),
      ...(opts.layoutKey === undefined ? {} : { layoutKey: opts.layoutKey }),
    },
    metadata: {
      id: `00000000-0000-4000-8000-${name.length.toString().padStart(12, '0')}`,
      name,
      version: '0.0.0',
      description: `${name} fixture`,
    },
    commands: [],
    commandSpecs: [
      defineCommand({
        name: primaryName,
        description: `${primaryName} primary`,
        commonFlags: ['json'],
        scope: 'project',
        output: 'command-result',
        handler: noopHandler,
      }),
    ],
  };
}

function collectExamples(catalog: AgentCatalog): readonly string[] {
  return [
    ...catalog.entryPoints.flatMap((entry) => entry.examples),
    ...catalog.commonPatterns.map((pattern) => pattern.example),
  ];
}

describe('agent-catalog parity contract', () => {
  it('throws ValidationError when a curated overlay key cannot match a tool name or alias', () => {
    const tools = new ToolRegistry();
    tools.register(fixtureTool('alpha'));

    expect(() =>
      assertAgentCatalogOverlayKeys(tools, new Set(), {
        beta: { description: 'stale overlay' },
      }),
    ).toThrow(ValidationError);

    try {
      assertAgentCatalogOverlayKeys(tools, new Set(), {
        beta: { description: 'stale overlay' },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe('CORE.AGENT_CATALOG.UNPUBLISHABLE');
    }
  });

  it('accepts a curated overlay key that matches a documented alias or layout key', () => {
    const tools = new ToolRegistry();
    tools.register(fixtureTool('simulation', { aliases: ['sim'], layoutKey: 'sim' }));

    expect(() =>
      assertAgentCatalogOverlayKeys(tools, new Set(), {
        sim: { examples: ['opensip sim --json'] },
      }),
    ).not.toThrow();

    const catalog = buildAgentCatalog({ tools });
    expect(catalog.entryPoints.find((entry) => entry.command === 'simulation')?.examples).toEqual([
      'opensip sim --json',
      'opensip sim --recipe default --json',
    ]);
  });

  it('keeps catalog examples well-formed for machine consumers', () => {
    const catalog = buildAgentCatalog();
    for (const example of collectExamples(catalog)) {
      expect(example).toMatch(/^opensip\s/);
      expect(example).not.toMatch(/\s{2,}/);
    }

    expect(catalog.entryPoints.filter((entry) => entry.command === 'audit')).toHaveLength(1);
    expect(collectExamples(catalog)).toContain('opensip audit --json');
  });
});

describe('agent-catalog host-support parity handoff (Plan 02 → Plan 03)', () => {
  const projection = {
    status: 'preview',
    match: 'partial',
    rowId: 'macos-26-arm64-node24-npm11-v1',
    rowStatus: 'preview',
    profile: { id: 'macos-26-arm64-node24-npm11-v1', version: 1 },
    docsUrl: 'https://opensip.ai/docs/opensip-cli/70-reference/17-supported-platforms',
    reasonCodes: [],
    observed: ['os-platform', 'arch', 'node-major', 'node-abi'],
    unobserved: ['npm-major', 'filesystem-type', 'install-channel'],
  } as const;

  it('two builds with identical facts + hostSupport are byte-identical full catalogs', () => {
    const tools = new ToolRegistry();
    tools.register(fixtureTool('graph'));
    const hostSupport = hostSupportFromRuntimeProjection(projection, 1);
    const a = buildAgentCatalog({ tools, hostSupport });
    const b = buildAgentCatalog({ tools, hostSupport });
    // Full-object determinism — the CLI/MCP composition roots feed identical
    // inputs into this one builder, so their catalogs cannot diverge.
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.hostSupport).toEqual(hostSupport);
  });

  it('omits hostSupport when absent so the field is purely additive', () => {
    expect(buildAgentCatalog().hostSupport).toBeUndefined();
    // A future common parity assembler can accept the exact same optional input
    // without an adapter or field rename: `AgentCatalog.hostSupport` IS
    // `AgentHostSupport | undefined`, and the mapper output is assignable to it.
    const assemblerInput: { readonly hostSupport?: AgentHostSupport } = {
      hostSupport: hostSupportFromRuntimeProjection(projection, 1),
    };
    const catalog: AgentCatalog = buildAgentCatalog(assemblerInput);
    expect(catalog.hostSupport).toEqual(assemblerInput.hostSupport);
  });
});

// Plan 03 full-object parity fixture: one deterministic runtime/project fixture
// (public/internal Tool commands, complete host inventory with aliases/groups,
// reserved suites, non-empty target conventions, Plan 02's partial hostSupport)
// exercised through the two NEW common-projection surfaces directly, so a future
// common field cannot silently reach only one transport.
describe('agent-catalog common projection surfaces (Plan 03)', () => {
  const RESERVED_SUITE_NAMES = ['audit', 'agent-context'] as const;
  const previewProjection = {
    status: 'preview',
    match: 'partial',
    rowId: 'macos-26-arm64-node24-npm11-v1',
    rowStatus: 'preview',
    profile: { id: 'macos-26-arm64-node24-npm11-v1', version: 1 },
    docsUrl: 'https://opensip.ai/docs/opensip-cli/70-reference/17-supported-platforms',
    reasonCodes: [],
    observed: ['os-platform', 'arch', 'node-major', 'node-abi'],
    unobserved: ['npm-major', 'filesystem-type', 'install-channel'],
  } as const;

  function hostLeaf(
    over: Partial<RuntimeCommandLeaf> & Pick<RuntimeCommandLeaf, 'path' | 'name'>,
  ): RuntimeCommandLeaf {
    return {
      aliases: [],
      owner: 'host',
      ownerLabel: 'cli',
      visibility: 'public',
      scope: 'project',
      output: 'command-result',
      ...over,
    };
  }

  function toolLeaf(
    over: Partial<RuntimeCommandLeaf> & Pick<RuntimeCommandLeaf, 'path' | 'name' | 'ownerLabel'>,
  ): RuntimeCommandLeaf {
    return {
      aliases: [],
      owner: 'tool',
      visibility: 'public',
      scope: 'project',
      output: 'command-result',
      ...over,
    };
  }

  function hostGroup(
    over: Partial<RuntimeCommandGroup> & Pick<RuntimeCommandGroup, 'path' | 'name'>,
  ): RuntimeCommandGroup {
    return { owner: 'host', ownerLabel: 'cli', visibility: 'public', ...over };
  }

  const inventory = createRuntimeCommandInventory({
    complete: true,
    leaves: [
      hostLeaf({ path: 'audit', name: 'audit' }),
      hostLeaf({ path: 'init', name: 'init' }),
      hostLeaf({ path: 'report', name: 'report', aliases: ['rpt'] }),
      hostLeaf({ path: 'sessions list', name: 'list' }), // nested host leaf → excluded
      toolLeaf({ path: 'graph', name: 'graph', ownerLabel: 'graph' }),
      toolLeaf({
        path: 'graph-run-worker',
        name: 'graph-run-worker',
        ownerLabel: 'graph',
        visibility: 'internal',
      }),
      // Public-looking name deliberately classified internal by the captured
      // inventory. Its matching registry primary below proves the projected
      // internalCommands set survives shared-assembler forwarding.
      toolLeaf({
        path: 'hidden-primary',
        name: 'hidden-primary',
        ownerLabel: 'hidden-primary',
        visibility: 'internal',
      }),
    ],
    groups: [hostGroup({ path: 'sessions', name: 'sessions' })],
  });

  const partialHostSupport = hostSupportFromRuntimeProjection(previewProjection, 1);
  const targetConventions = [
    { target: 'app', entrypointCount: 2, alwaysUsedCount: 1, usedExportCount: 3 },
  ];

  function overlayTools(): ToolRegistry {
    const tools = new ToolRegistry();
    for (const name of ['fitness', 'graph', 'sim', 'yagni']) tools.register(fixtureTool(name));
    tools.register(fixtureTool('hidden-primary'));
    return tools;
  }

  it('projects reserved roots + internal commands from the complete inventory', () => {
    const facts = projectAgentCatalogRuntimeFacts(inventory, ['help']);
    expect(facts.rootCommands).toEqual(['audit', 'help', 'init', 'report', 'rpt', 'sessions']);
    // Both Tool-owned internal primaries survive projection; the nested host leaf does not.
    expect(facts.internalCommands).toEqual(['graph-run-worker', 'hidden-primary']);
  });

  it('assembles the full common catalog surface directly from those facts', () => {
    const facts = projectAgentCatalogRuntimeFacts(inventory, ['help']);
    const catalog = assembleAgentCatalog({
      tools: overlayTools(),
      internalCommands: new Set(facts.internalCommands),
      rootCommands: facts.rootCommands,
      suiteNames: RESERVED_SUITE_NAMES,
      hostSupport: partialHostSupport,
      projectContext: { targetConventions },
    });

    // Reserved names carried verbatim (roots pre-sorted; suites keep audit first).
    expect(catalog.reservedNames).toEqual({
      rootCommands: ['audit', 'help', 'init', 'report', 'rpt', 'sessions'],
      suiteNames: ['audit', 'agent-context'],
    });
    // Non-empty bounded target conventions present.
    expect(catalog.projectContext?.targetConventions).toEqual(targetConventions);
    // The ENTIRE Plan 02 partial hostSupport object is present, byte-identical.
    expect(catalog.hostSupport).toEqual(partialHostSupport);
    expect(JSON.stringify(catalog.hostSupport)).toBe(JSON.stringify(partialHostSupport));
    // Public Tool commands surface as entry points; the internal worker never does.
    const commands = catalog.entryPoints.map((entry) => entry.command);
    expect(commands).toContain('graph');
    expect(commands).not.toContain('graph-run-worker');
    expect(commands).not.toContain('hidden-primary');
  });
});
