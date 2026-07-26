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
import {
  agentCatalogOverlayKeys,
  compareCodePoint,
  publicPrimaryCommand,
} from '../agent-catalog-entries.js';
import { buildAgentCatalog } from '../agent-catalog.js';
import { hostSupportFromRuntimeProjection } from '../host-support.js';

const noopHandler = (): Promise<{ type: 'text-lines'; lines: string[] }> =>
  Promise.resolve({ type: 'text-lines', lines: [] });

function fixtureTool(over: Partial<Tool> & Pick<Tool, 'metadata'>): Tool {
  return {
    identity: { name: over.metadata.name },
    commands: [],
    commandSpecs: [
      defineCommand({
        name: over.metadata.name,
        description: `${over.metadata.name} primary`,
        commonFlags: ['json'],
        scope: 'project',
        output: 'command-result',
        handler: noopHandler,
      }),
    ],
    ...over,
  };
}

describe('buildAgentCatalog', () => {
  it('returns platform entry points when no registry is supplied', () => {
    const catalog = buildAgentCatalog();
    expect(catalog.version).toBe('1.0.0');
    expect(catalog.entryPoints.map((entry) => entry.command)).toEqual([
      'audit',
      'suite run',
      'status',
      'runs list',
      'runs show',
      'sessions list',
      'sessions show',
      'agent-catalog',
      'policy status',
      'policy explain',
      'policy audit',
    ]);
    expect(catalog.commonPatterns.length).toBeGreaterThan(0);
    expect(
      catalog.commonPatterns.some((pattern) => pattern.description.includes('review_change')),
    ).toBe(true);
    expect(JSON.stringify(catalog)).toContain('MCP review_change');
    expect(JSON.stringify(catalog)).toContain('opensip audit --json');
    expect(JSON.stringify(catalog)).toContain('opensip audit --files src/server.ts --json');
    expect(JSON.stringify(catalog)).toContain('opensip suite run security --json');
    expect(JSON.stringify(catalog)).toContain('opensip status --json');
    expect(JSON.stringify(catalog)).toContain('opensip runs list --json');
    expect(JSON.stringify(catalog)).toContain('opensip runs show RUN_EXAMPLE_01 --json');
    expect(JSON.stringify(catalog)).toContain('opensip policy explain installed-tool:audit-sec');
    expect(catalog.outputShapes.reviewBrief).toMatch(/reviewBrief|version: 1/);
    expect(catalog.outputShapes.reviewBrief).toContain(
      'scope?: { mode, source, ref?, changedFiles?, notice? }',
    );
    expect(catalog.outputShapes.reviewBrief).toContain('runId?');
    expect(catalog.outputShapes.taskContext).toContain('contextManifest');
    expect(catalog.outputShapes.taskContext).toContain('fileScope.status');
    expect(catalog.outputShapes.taskContext).toContain('createdAt');
    expect(catalog.outputShapes.taskContext).toContain('projectIdentity');
    expect(catalog.outputShapes.taskContext).toContain('producer:{toolId,command,version}');
    expect(catalog.outputShapes.taskContext).toContain('freshness,coverage,caps');
    expect(catalog.outputShapes.taskContext).toContain('available + matched + ready');
    expect(catalog.outputShapes.taskContext).toContain('raw paths are never stored');
    expect(catalog.outputShapes.taskContext).toContain('not a finding');
    expect(catalog.notes.length).toBeGreaterThan(0);
    expect(
      catalog.notes.some((note) => note.includes('same explicit project-relative files')),
    ).toBe(true);
  });

  it('derives sorted tool entry points with overlays and excludes internal commands', () => {
    const tools = new ToolRegistry();
    tools.register(
      fixtureTool({
        metadata: {
          id: '00000000-0000-4000-8000-000000000201',
          name: 'graph',
          version: '0.0.0',
          description: 'graph tool',
        },
      }),
    );
    tools.register(
      fixtureTool({
        metadata: {
          id: '00000000-0000-4000-8000-000000000202',
          name: 'fitness',
          version: '0.0.0',
          description: 'fitness tool',
        },
        identity: { name: 'fitness', aliases: ['fit'], layoutKey: 'fit' },
        commandSpecs: [
          defineCommand({
            name: 'fitness',
            description: 'Run fitness',
            commonFlags: ['json'],
            scope: 'project',
            output: 'command-result',
            handler: noopHandler,
          }),
        ],
      }),
    );
    tools.register({
      identity: { name: 'hidden-worker' },
      metadata: {
        id: '00000000-0000-4000-8000-000000000203',
        name: 'hidden-worker',
        version: '0.0.0',
        description: 'internal only',
      },
      commands: [],
      commandSpecs: [
        defineCommand({
          name: 'hidden-worker-run-worker',
          description: 'internal worker',
          visibility: 'internal',
          commonFlags: [],
          scope: 'project',
          output: 'raw-stream',
          rawStreamReason: 'worker-ipc',
          handler: noopHandler,
        }),
      ],
    });

    const catalog = buildAgentCatalog({ tools });
    const commands = catalog.entryPoints.map((entry) => entry.command);

    expect(commands).toContain('fitness');
    expect(commands).toContain('graph');
    expect(commands).not.toContain('hidden-worker-run-worker');
    expect(commands.indexOf('fitness')).toBeLessThan(commands.indexOf('graph'));
    expect(catalog.entryPoints.find((entry) => entry.command === 'fitness')?.tier).toBe('tool');
    expect(catalog.entryPoints.find((entry) => entry.command === 'fitness')?.examples?.[0]).toMatch(
      /agent-fast/,
    );
  });

  it('honours the internalCommands denylist', () => {
    const tools = new ToolRegistry();
    tools.register(
      fixtureTool({
        metadata: {
          id: '00000000-0000-4000-8000-000000000204',
          name: 'alpha',
          version: '0.0.0',
          description: 'alpha tool',
        },
      }),
    );

    const catalog = buildAgentCatalog({
      tools,
      internalCommands: new Set(['alpha']),
    });

    expect(catalog.entryPoints.map((entry) => entry.command)).not.toContain('alpha');
  });

  it('does not synthesize --json examples for primaries that do not declare json', () => {
    const tools = new ToolRegistry();
    tools.register({
      identity: { name: 'mcp' },
      metadata: {
        id: '00000000-0000-4000-8000-000000000205',
        name: 'mcp',
        version: '0.0.0',
        description: 'mcp tool',
      },
      commands: [],
      commandSpecs: [
        defineCommand({
          name: 'mcp',
          description: 'Serve MCP over stdio',
          commonFlags: ['cwd'],
          scope: 'project',
          output: 'raw-stream',
          rawStreamReason: 'mcp-stdio',
          handler: noopHandler,
        }),
      ],
    });

    const catalog = buildAgentCatalog({ tools });
    const mcp = catalog.entryPoints.find((entry) => entry.command === 'mcp');

    expect(mcp?.examples).toEqual(['opensip mcp']);
    expect(mcp?.description).toMatch(/Raw-stream transport/);
  });

  it('includes project context only when target conventions are present and describes non-json command output', () => {
    const tools = new ToolRegistry();
    tools.register({
      identity: { name: 'plain' },
      metadata: {
        id: '00000000-0000-4000-8000-000000000206',
        name: 'plain',
        version: '0.0.0',
        description: 'plain tool',
      },
      commands: [],
      commandSpecs: [
        defineCommand({
          name: 'plain',
          description: 'Run plain output',
          commonFlags: ['cwd'],
          scope: 'project',
          output: 'command-result',
          handler: noopHandler,
        }),
      ],
    });

    expect(
      buildAgentCatalog({
        projectContext: { targetConventions: [] },
      }).projectContext,
    ).toBeUndefined();

    const catalog = buildAgentCatalog({
      tools,
      projectContext: {
        targetConventions: [
          {
            target: 'src',
            entrypointCount: 0,
            alwaysUsedCount: 1,
            usedExportCount: 0,
          },
        ],
      },
    });

    const plain = catalog.entryPoints.find((entry) => entry.command === 'plain');
    expect(plain?.examples).toEqual(['opensip plain']);
    expect(plain?.description).toContain('does not declare --json');
    expect(catalog.projectContext?.targetConventions).toHaveLength(1);
  });

  it('validates curated overlay keys when validateOverlays is enabled', () => {
    const tools = new ToolRegistry();
    tools.register(
      fixtureTool({
        metadata: {
          id: '00000000-0000-4000-8000-000000000207',
          name: 'fitness',
          version: '0.0.0',
          description: 'fitness tool',
        },
      }),
    );
    tools.register(
      fixtureTool({
        metadata: {
          id: '00000000-0000-4000-8000-000000000208',
          name: 'graph',
          version: '0.0.0',
          description: 'graph tool',
        },
      }),
    );
    tools.register(
      fixtureTool({
        metadata: {
          id: '00000000-0000-4000-8000-000000000209',
          name: 'sim',
          version: '0.0.0',
          description: 'sim tool',
        },
      }),
    );
    tools.register(
      fixtureTool({
        metadata: {
          id: '00000000-0000-4000-8000-000000000210',
          name: 'yagni',
          version: '0.0.0',
          description: 'yagni tool',
        },
      }),
    );

    expect(() => buildAgentCatalog({ tools, validateOverlays: true })).not.toThrow();
    expect(() => buildAgentCatalog({ validateOverlays: true })).not.toThrow();
  });

  it('includes reservedNames when provided', () => {
    const catalog = buildAgentCatalog({
      reservedNames: {
        rootCommands: ['audit', 'suite'],
        suiteNames: ['agent-context'],
      },
    });
    expect(catalog.reservedNames).toEqual({
      rootCommands: ['audit', 'suite'],
      suiteNames: ['agent-context'],
    });
  });

  it('omits hostSupport when the composition root does not inject it (absent-field)', () => {
    expect(buildAgentCatalog().hostSupport).toBeUndefined();
    expect(buildAgentCatalog({}).hostSupport).toBeUndefined();
  });

  it('includes the injected hostSupport projection additively', () => {
    const hostSupport = hostSupportFromRuntimeProjection(
      {
        status: 'preview',
        match: 'partial',
        rowId: 'macos-26-arm64-node24-npm11-v1',
        rowStatus: 'preview',
        profile: { id: 'macos-26-arm64-node24-npm11-v1', version: 1 },
        docsUrl: 'https://opensip.ai/docs/opensip-cli/70-reference/17-supported-platforms',
        reasonCodes: [],
        observed: ['os-platform', 'arch', 'node-major', 'node-abi'],
        unobserved: ['npm-major', 'filesystem-type', 'install-channel'],
      },
      1,
    );
    const catalog = buildAgentCatalog({ hostSupport });
    expect(catalog.hostSupport).toEqual(hostSupport);
  });
});

describe('hostSupportFromRuntimeProjection', () => {
  const previewProjection = {
    status: 'preview',
    match: 'partial',
    rowId: 'macos-26-arm64-node24-npm11-v1',
    rowStatus: 'preview',
    profile: { id: 'macos-26-arm64-node24-npm11-v1', version: 1 },
    docsUrl: 'https://opensip.ai/docs/opensip-cli/70-reference/17-supported-platforms',
    reasonCodes: [],
    observed: ['os-platform', 'arch', 'node-major', 'node-abi'],
    unobserved: [
      'os-version',
      'kernel-name',
      'kernel-version',
      'npm-major',
      'filesystem-type',
      'install-channel',
    ],
  } as const;

  it('mirrors the core projection into the serializable shape (matrixUrl from docsUrl)', () => {
    const mapped = hostSupportFromRuntimeProjection(previewProjection, 1);
    expect(mapped).toEqual({
      supportContractVersion: 1,
      status: 'preview',
      match: 'partial',
      rowId: 'macos-26-arm64-node24-npm11-v1',
      rowStatus: 'preview',
      profile: { id: 'macos-26-arm64-node24-npm11-v1', version: 1 },
      matrixUrl: previewProjection.docsUrl,
      reasonCodes: [],
      observed: ['os-platform', 'arch', 'node-major', 'node-abi'],
      unobserved: [
        'os-version',
        'kernel-name',
        'kernel-version',
        'npm-major',
        'filesystem-type',
        'install-channel',
      ],
    });
  });

  it('is deterministic: identical inputs serialize byte-identically (CLI/MCP parity)', () => {
    const a = hostSupportFromRuntimeProjection(previewProjection, 1);
    const b = hostSupportFromRuntimeProjection(previewProjection, 1);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('never yields an exact match and preserves null profile/matrix for unqualified hosts', () => {
    const mapped = hostSupportFromRuntimeProjection(
      {
        status: 'unqualified',
        match: 'none',
        rowId: null,
        rowStatus: null,
        profile: null,
        docsUrl: null,
        reasonCodes: ['unqualified-host'],
        observed: ['os-platform', 'arch', 'node-major', 'node-abi'],
        unobserved: [],
      },
      1,
    );
    expect(mapped.match).not.toBe('exact');
    expect(mapped.match).toBe('none');
    expect(mapped.profile).toBeNull();
    expect(mapped.matrixUrl).toBeNull();
    expect(mapped.reasonCodes).toEqual(['unqualified-host']);
  });

  it('preserves the stable reason-code, observed, and unobserved ordering (copies, not aliases)', () => {
    const reasonCodes = ['os-version-mismatch', 'node-abi-mismatch', 'npm-major-mismatch'];
    const observed = ['os-platform', 'arch'];
    const unobserved = ['npm-major', 'filesystem-type', 'install-channel'];
    const mapped = hostSupportFromRuntimeProjection(
      {
        status: 'unqualified',
        match: 'none',
        rowId: null,
        rowStatus: null,
        profile: null,
        docsUrl: null,
        reasonCodes,
        observed,
        unobserved,
      },
      1,
    );
    // Order is carried through verbatim — agents rely on a stable reason order.
    expect(mapped.reasonCodes).toEqual(reasonCodes);
    expect(mapped.observed).toEqual(observed);
    expect(mapped.unobserved).toEqual(unobserved);
    // The mapper copies the arrays — mutating the source never mutates the output.
    reasonCodes.push('mutated');
    expect(mapped.reasonCodes).not.toContain('mutated');
  });
});

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
  over: Partial<RuntimeCommandLeaf> & Pick<RuntimeCommandLeaf, 'path' | 'name'>,
): RuntimeCommandLeaf {
  return {
    aliases: [],
    owner: 'tool',
    ownerLabel: over.ownerLabel ?? over.name,
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

function toolGroup(
  over: Partial<RuntimeCommandGroup> & Pick<RuntimeCommandGroup, 'path' | 'name'>,
): RuntimeCommandGroup {
  return { owner: 'tool', ownerLabel: over.name, visibility: 'public', ...over };
}

describe('assembleAgentCatalog', () => {
  const RESERVED_SUITE_NAMES = ['audit', 'agent-context'] as const;

  it('copies the authority-owned reserved lists verbatim without reordering', () => {
    // The suite order intentionally declares `audit` before `agent-context`; the
    // assembler must not sort or normalize the authority-owned lists.
    const rootCommands = ['suite', 'audit', 'init'];
    const catalog = assembleAgentCatalog({
      rootCommands,
      suiteNames: RESERVED_SUITE_NAMES,
    });
    expect(catalog.reservedNames).toEqual({
      rootCommands: ['suite', 'audit', 'init'],
      suiteNames: ['audit', 'agent-context'],
    });
  });

  it('makes defensive copies — mutating the source lists never mutates the result', () => {
    const rootCommands = ['audit', 'init'];
    const suiteNames = ['audit', 'agent-context'];
    const catalog = assembleAgentCatalog({ rootCommands, suiteNames });
    rootCommands.push('mutated-root');
    suiteNames.push('mutated-suite');
    expect(catalog.reservedNames?.rootCommands).toEqual(['audit', 'init']);
    expect(catalog.reservedNames?.suiteNames).toEqual(['audit', 'agent-context']);
  });

  it('omits an empty project context but passes a non-empty one through', () => {
    expect(
      assembleAgentCatalog({
        rootCommands: [],
        suiteNames: RESERVED_SUITE_NAMES,
        projectContext: { targetConventions: [] },
      }).projectContext,
    ).toBeUndefined();

    const catalog = assembleAgentCatalog({
      rootCommands: [],
      suiteNames: RESERVED_SUITE_NAMES,
      projectContext: {
        targetConventions: [
          { target: 'app', entrypointCount: 2, alwaysUsedCount: 1, usedExportCount: 3 },
        ],
      },
    });
    expect(catalog.projectContext?.targetConventions).toEqual([
      { target: 'app', entrypointCount: 2, alwaysUsedCount: 1, usedExportCount: 3 },
    ]);
  });

  it('forwards Plan 02 hostSupport byte-identically when present and omits it when absent', () => {
    const hostSupport = hostSupportFromRuntimeProjection(
      {
        status: 'preview',
        match: 'partial',
        rowId: 'macos-26-arm64-node24-npm11-v1',
        rowStatus: 'preview',
        profile: { id: 'macos-26-arm64-node24-npm11-v1', version: 1 },
        docsUrl: 'https://opensip.ai/docs/opensip-cli/70-reference/17-supported-platforms',
        reasonCodes: [],
        observed: ['os-platform', 'arch', 'node-major', 'node-abi'],
        unobserved: ['npm-major', 'filesystem-type', 'install-channel'],
      },
      1,
    );
    const withSupport = assembleAgentCatalog({
      rootCommands: [],
      suiteNames: RESERVED_SUITE_NAMES,
      hostSupport,
    });
    expect(withSupport.hostSupport).toEqual(hostSupport);
    expect(JSON.stringify(withSupport.hostSupport)).toBe(JSON.stringify(hostSupport));

    expect(
      assembleAgentCatalog({ rootCommands: [], suiteNames: RESERVED_SUITE_NAMES }).hostSupport,
    ).toBeUndefined();
  });

  it('delegates curated overlay validation (always validateOverlays: true)', () => {
    const tools = new ToolRegistry();
    tools.register(
      fixtureTool({
        metadata: {
          id: '00000000-0000-4000-8000-000000000301',
          name: 'alpha',
          version: '0.0.0',
          description: 'alpha tool',
        },
      }),
    );
    // `alpha` has a public primary but does not match the curated fitness/graph/
    // sim/yagni overlay keys, so the delegated validator must throw.
    expect(() =>
      assembleAgentCatalog({ tools, rootCommands: [], suiteNames: RESERVED_SUITE_NAMES }),
    ).toThrow(ValidationError);
  });

  it('produces the same full catalog as buildAgentCatalog with equivalent inputs', () => {
    const rootCommands = ['audit', 'init', 'suite'];
    const assembled = assembleAgentCatalog({
      rootCommands,
      suiteNames: RESERVED_SUITE_NAMES,
    });
    const built = buildAgentCatalog({
      reservedNames: {
        rootCommands: ['audit', 'init', 'suite'],
        suiteNames: ['audit', 'agent-context'],
      },
      validateOverlays: true,
    });
    expect(assembled).toEqual(built);
  });
});

describe('projectAgentCatalogRuntimeFacts', () => {
  it('projects top-level host names + aliases + implicit roots and excludes nested/tool/plugin paths', () => {
    const inventory = createRuntimeCommandInventory({
      complete: true,
      leaves: [
        hostLeaf({ path: 'audit', name: 'audit' }),
        hostLeaf({ path: 'init', name: 'init' }),
        hostLeaf({ path: 'report', name: 'report', aliases: ['rpt'] }),
        // A host-owned internal top-level leaf is STILL a reserved root...
        hostLeaf({
          path: '__tool-command-worker',
          name: '__tool-command-worker',
          visibility: 'internal',
        }),
        // ...but a nested host leaf, a Tool command, and a nested plugin leaf are not.
        hostLeaf({ path: 'sessions list', name: 'list' }),
        toolLeaf({ path: 'fit', name: 'fit' }),
        toolLeaf({ path: 'graph', name: 'graph' }),
        toolLeaf({ path: 'fit plugin add', name: 'add', ownerLabel: 'fit' }),
        // A Tool-owned internal worker is the ONLY internal-command source.
        toolLeaf({
          path: 'fit-run-worker',
          name: 'fit-run-worker',
          visibility: 'internal',
          ownerLabel: 'fit',
        }),
      ],
      groups: [
        hostGroup({ path: 'sessions', name: 'sessions' }),
        hostGroup({ path: 'tools', name: 'tools' }),
        toolGroup({ path: 'fit plugin', name: 'plugin', ownerLabel: 'fit' }),
      ],
    });

    // `audit` is duplicated between a host leaf and an implicit root → dedup.
    const facts = projectAgentCatalogRuntimeFacts(inventory, ['help', 'audit']);

    expect(facts.rootCommands).toEqual([
      '__tool-command-worker',
      'audit',
      'help',
      'init',
      'report',
      'rpt',
      'sessions',
      'tools',
    ]);
    // Host-owned internal leaf is NOT an internal command; only the Tool worker is.
    expect(facts.internalCommands).toEqual(['fit-run-worker']);
    // Code-point sorted and de-duplicated.
    expect([...facts.rootCommands]).toEqual([...facts.rootCommands].sort(compareCodePoint));
    expect(new Set(facts.rootCommands).size).toBe(facts.rootCommands.length);
  });

  it('honors code-point (not locale) ordering for uppercase roots', () => {
    const inventory = createRuntimeCommandInventory({
      complete: true,
      leaves: [hostLeaf({ path: 'audit', name: 'audit' }), hostLeaf({ path: 'Zed', name: 'Zed' })],
    });
    // 'Z' (U+005A) sorts before 'a' (U+0061) by code point.
    expect(projectAgentCatalogRuntimeFacts(inventory, []).rootCommands).toEqual(['Zed', 'audit']);
  });

  it('fails closed with a typed ValidationError on an incomplete inventory', () => {
    const inventory = createRuntimeCommandInventory({
      complete: false,
      leaves: [hostLeaf({ path: 'audit', name: 'audit' })],
      reasons: ['third-party-omitted'],
    });
    expect(() => projectAgentCatalogRuntimeFacts(inventory, ['help'])).toThrow(ValidationError);
    try {
      projectAgentCatalogRuntimeFacts(inventory, ['help']);
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code).toBe('SYSTEM.AGENT_CATALOG.UNPUBLISHABLE');
    }
  });
});

describe('agent-catalog-entries helpers', () => {
  it('orders overlay keys by code point and compares strings inclusively', () => {
    expect(compareCodePoint('a', 'b')).toBe(-1);
    expect(compareCodePoint('b', 'a')).toBe(1);
    expect(compareCodePoint('same', 'same')).toBe(0);
    expect(agentCatalogOverlayKeys()).toEqual(['fitness', 'graph', 'sim', 'yagni']);
  });

  it('returns undefined when a tool has no public primary command', () => {
    const tool: Tool = {
      identity: { name: 'worker-only' },
      metadata: {
        id: '00000000-0000-4000-8000-000000000211',
        name: 'worker-only',
        version: '0.0.0',
        description: 'worker only',
      },
      commands: [],
      commandSpecs: [
        defineCommand({
          name: 'worker-only-run-worker',
          description: 'internal',
          visibility: 'internal',
          commonFlags: [],
          scope: 'project',
          output: 'raw-stream',
          rawStreamReason: 'worker-ipc',
          handler: noopHandler,
        }),
      ],
    };
    expect(publicPrimaryCommand(tool, new Set())).toBeUndefined();

    const tools = new ToolRegistry();
    tools.register(tool);
    // Tool with no public primary contributes no overlay keys; stale curated keys still fail.
    expect(() =>
      buildAgentCatalog({
        tools,
        validateOverlays: true,
      }),
    ).toThrow(ValidationError);
  });
});
