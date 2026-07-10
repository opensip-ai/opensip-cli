import {
  ToolRegistry,
  type CommandSpec,
  type Tool,
  type ToolCliContext,
  type ToolPluginManifest,
  type ToolProvenance,
} from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { LiveRuntimeWiringReadPort } from '../live-runtime-wiring-read-port.js';
import { MAX_RUNTIME_FACTS } from '../runtime-wiring-capture.js';

import type { RuntimeWiringQuery } from '../runtime-wiring-read-port.js';

const STABLE_ID = '11111111-1111-4111-8111-111111111111';

function command(name: string, parent?: string): CommandSpec<unknown, ToolCliContext> {
  function fixtureHandler(): undefined {
    return undefined;
  }
  return {
    name,
    description: 'not projected',
    aliases: [],
    commonFlags: [],
    scope: 'project',
    output: 'command-result',
    parent,
    handler: fixtureHandler,
  };
}

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    identity: { name: 'alpha', aliases: ['a'], layoutKey: 'alpha-layout' },
    metadata: {
      id: STABLE_ID,
      name: 'alpha',
      version: '1.2.3',
      description: 'fixture',
    },
    commandSpecs: [command('alpha'), command('inspect', 'alpha')],
    ...overrides,
  };
}

function manifest(overrides: Partial<ToolPluginManifest> = {}): ToolPluginManifest {
  return {
    kind: 'tool',
    apiVersion: 1,
    id: 'alpha',
    stableId: STABLE_ID,
    identity: { name: 'alpha' },
    name: 'Alpha',
    version: '1.2.3',
    commands: [],
    ...overrides,
  };
}

function provenance(overrides: Partial<ToolProvenance> = {}): ToolProvenance {
  return {
    source: 'bundled',
    id: 'alpha',
    stableId: STABLE_ID,
    version: '1.2.3',
    packageName: '@fixture/alpha',
    resolvedPath: '/secret/project/node_modules/@fixture/alpha',
    manifestHash: 'secret-manifest-hash',
    ...overrides,
  };
}

function port(
  options: {
    readonly projectRoot?: string;
    readonly tools?: readonly Tool[];
    readonly manifests?: readonly ToolPluginManifest[];
    readonly provenance?: readonly ToolProvenance[];
  } = {},
): LiveRuntimeWiringReadPort {
  const registry = new ToolRegistry();
  for (const value of options.tools ?? [tool()]) registry.register(value);
  return new LiveRuntimeWiringReadPort({
    projectRoot: options.projectRoot ?? '/fixture/project',
    tools: registry,
    manifests: options.manifests ?? [manifest()],
    provenance: options.provenance ?? [provenance()],
  });
}

describe('LiveRuntimeWiringReadPort', () => {
  it('returns deterministic repeated projections from one immutable snapshot', async () => {
    const runtime = port();
    const first = await runtime.query({ groupBy: 'source', limit: 100 });
    const second = await runtime.query({ groupBy: 'source', limit: 100 });
    expect(second).toEqual(first);
  });

  it('enumerates the source registry once and reuses the captured identity index', async () => {
    const registry = new ToolRegistry();
    registry.register(tool());
    const list = vi.spyOn(registry, 'list');
    const values = vi.spyOn(registry, 'values');
    const runtime = new LiveRuntimeWiringReadPort({
      projectRoot: '/fixture/project',
      tools: registry,
      manifests: [manifest()],
      provenance: [provenance()],
    });

    await runtime.query({ tool: 'a', limit: 100 });
    await runtime.query({ tool: 'alpha-layout', limit: 100 });

    expect(values).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
  });

  it('maps unexpected query-shape failures to a typed Result error', async () => {
    const hostile = {} as RuntimeWiringQuery;
    Object.defineProperty(hostile, 'limit', {
      get() {
        throw new Error('untrusted getter');
      },
    });
    const outcome = await port().query(hostile);
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'runtime-wiring-failed' },
    });
  });

  it('projects admitted manifest, registry, nesting, mount, and handler evidence', async () => {
    const outcome = await port().query({ limit: 100 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.context.projectKey).not.toContain('/fixture/project');
    expect(outcome.value.context.snapshotKey).toMatch(/^g1:/);
    expect(outcome.value.coverage).toMatchObject({
      complete: true,
      scope: 'captured-admitted-tool-registry',
      truncated: false,
    });
    expect(outcome.value.coverage.reasons).toContain('top-level-host-commands-outside-port');
    expect(outcome.value.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'provenance',
        provenanceSource: 'bundled',
        packageName: '@fixture/alpha',
      }),
    );
    expect(outcome.value.edges).toContainEqual(
      expect.objectContaining({
        kind: 'manifest-admits-tool',
        source: 'provenance',
        reason: 'host-admitted-provenance',
      }),
    );
    expect(
      outcome.value.edges.every((edge) => edge.source && edge.confidence && edge.staticBridge),
    ).toBe(true);
    expect([...new Set(outcome.value.edges.map((edge) => edge.kind))]).toEqual(
      expect.arrayContaining([
        'manifest-admits-tool',
        'registry-owns-command',
        'command-nests-under',
        'host-mounts-command',
        'command-dispatches-handler',
      ]),
    );
    const dispatch = outcome.value.edges.find((edge) => edge.kind === 'command-dispatches-handler');
    expect(dispatch).toMatchObject({
      source: 'command-spec',
      confidence: 'medium',
      staticBridge: 'unresolved',
    });
    expect(outcome.value.nodes.find((node) => node.id === dispatch?.from)?.kind).toBe('host-mount');
    expect(outcome.value.nodes.find((node) => node.id === dispatch?.to)?.kind).toBe('handler');
    const serialized = JSON.stringify(outcome.value);
    expect(serialized).not.toContain('resolvedPath');
    expect(serialized).not.toContain('manifestHash');
    expect(serialized).not.toContain('/secret/project');
    expect(serialized).not.toContain('not projected');
  });

  it('resolves aliases/layout keys and groups by tool or provenance source', async () => {
    const byAlias = await port().query({
      tool: 'a',
      groupBy: 'tool',
      limit: 100,
    });
    expect(byAlias.ok).toBe(true);
    if (!byAlias.ok) return;
    expect(byAlias.value.effectiveFilters.tool).toBe('alpha');
    expect(byAlias.value.nodes.every((node) => node.tool === 'alpha')).toBe(true);
    expect(byAlias.value.groups).toContainEqual({
      key: 'alpha',
      count: expect.any(Number),
    });

    const bySource = await port().query({
      tool: 'alpha-layout',
      provenanceSource: 'bundled',
      groupBy: 'source',
      limit: 100,
    });
    expect(bySource.ok).toBe(true);
    if (!bySource.ok) return;
    expect(bySource.value.nodes.length).toBeGreaterThan(0);
    expect(bySource.value.groups).toContainEqual({
      key: 'bundled',
      count: expect.any(Number),
    });

    const hostLayout = await port({
      tools: [
        tool({
          pluginLayout: { domain: 'plugin-layout', userSubdirs: [] },
        }),
      ],
    }).query({ tool: 'plugin-layout', limit: 100 });
    expect(hostLayout.ok).toBe(true);
    if (!hostLayout.ok) return;
    expect(hostLayout.value.effectiveFilters.tool).toBe('alpha');
    expect(hostLayout.value.nodes).toContainEqual(
      expect.objectContaining({ kind: 'tool', layoutKey: 'plugin-layout' }),
    );
  });

  it('falls back from absent stable ids to canonical alias/layout identity', async () => {
    const outcome = await port({
      manifests: [
        manifest({
          stableId: undefined,
          id: 'alpha-layout',
          identity: { name: 'alpha-layout' },
        }),
      ],
      provenance: [provenance({ stableId: undefined, id: 'a' })],
    }).query({ limit: 100 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.coverage.complete).toBe(true);
    expect(outcome.value.edges).toContainEqual(
      expect.objectContaining({
        kind: 'manifest-admits-tool',
        confidence: 'high',
      }),
    );
    expect(outcome.value.nodes).toContainEqual(
      expect.objectContaining({ kind: 'tool', provenanceSource: 'bundled' }),
    );
  });

  it('labels external worker posture without exposing provenance secrets', async () => {
    const outcome = await port({
      provenance: [
        provenance({
          source: 'project-local',
          packageName: '@fixture/external',
          resolvedPath: '/private/external',
          manifestHash: 'private-hash',
        }),
      ],
    }).query({ limit: 100 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'worker-posture',
        workerPosture: 'isolated-worker-proxy',
        provenanceSource: 'project-local',
      }),
    );
    expect(outcome.value.edges).toContainEqual(
      expect.objectContaining({
        kind: 'external-worker-dispatch',
        source: 'provenance',
      }),
    );
    expect(JSON.stringify(outcome.value)).not.toMatch(/private-hash|\/private\/external/);
  });

  it('refuses an accessor command surface without invoking it', async () => {
    let invoked = false;
    const accessorTool = tool();
    Object.defineProperty(accessorTool, 'commandSpecs', {
      configurable: true,
      get() {
        invoked = true;
        throw new Error('must not run');
      },
    });
    const outcome = await port({ tools: [accessorTool] }).query({ limit: 100 });
    expect(invoked).toBe(false);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.coverage.complete).toBe(false);
    expect(outcome.value.coverage.reasons).toContain('command-surface-missing-or-accessor');
    expect(outcome.value.nodes.some((node) => node.kind === 'handler')).toBe(false);
  });

  it('treats a revoked command-array proxy as partial coverage instead of throwing', async () => {
    const commands = Proxy.revocable([command('alpha')], {});
    commands.revoke();

    const outcome = await port({
      tools: [tool({ commandSpecs: commands.proxy })],
    }).query({ limit: 100 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.coverage).toMatchObject({
      complete: false,
      truncated: false,
    });
    expect(outcome.value.coverage.reasons).toContain('command-surface-invalid');
    expect(outcome.value.nodes.some((node) => node.kind === 'command')).toBe(false);
  });

  it('omits a tool with revoked identity aliases instead of aborting startup', async () => {
    const aliases = Proxy.revocable(['a'], {});
    aliases.revoke();
    const outcome = await port({
      tools: [
        tool({
          identity: { name: 'alpha', aliases: aliases.proxy, layoutKey: 'alpha-layout' },
        }),
      ],
    }).query({ limit: 100 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.coverage).toMatchObject({ complete: false, truncated: false });
    expect(outcome.value.coverage.reasons).toContain('tool-identity-invalid-or-accessor');
    expect(outcome.value.nodes.some((node) => node.kind === 'tool')).toBe(false);
  });

  it('copies aliases by bounded descriptors without consulting a hostile iterator', async () => {
    let iteratorRead = false;
    const aliases = new Proxy(['a'], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          iteratorRead = true;
          throw new Error('must not iterate the mutable source array');
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const outcome = await port({
      tools: [tool({ identity: { name: 'alpha', aliases, layoutKey: 'alpha-layout' } })],
    }).query({ tool: 'a', limit: 100 });

    expect(iteratorRead).toBe(false);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.coverage.complete).toBe(true);
    expect(outcome.value.effectiveFilters.tool).toBe('alpha');
  });

  it('rejects oversized mutable identity text after the bounded prefix', async () => {
    const outcome = await port({
      tools: [
        tool({
          identity: {
            name: 'alpha',
            aliases: ['a'.repeat(2_000_000)],
            layoutKey: 'alpha-layout',
          },
        }),
      ],
    }).query({ limit: 100 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.coverage.reasons).toContain('tool-identity-invalid-or-accessor');
    expect(outcome.value.nodes.some((node) => node.kind === 'tool')).toBe(false);
  });

  it('refuses an accessor handler without invoking or inventing a dispatch edge', async () => {
    let invoked = false;
    const accessorSpec = command('alpha');
    Object.defineProperty(accessorSpec, 'handler', {
      configurable: true,
      get() {
        invoked = true;
        throw new Error('must not run');
      },
    });
    const outcome = await port({
      tools: [tool({ commandSpecs: [accessorSpec] })],
    }).query({
      limit: 100,
    });
    expect(invoked).toBe(false);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.coverage.complete).toBe(false);
    expect(outcome.value.coverage.reasons).toContain('command-handler-missing-or-accessor');
    expect(outcome.value.nodes.some((node) => node.kind === 'handler')).toBe(false);
    expect(outcome.value.edges.some((edge) => edge.kind === 'command-dispatches-handler')).toBe(
      false,
    );
  });

  it('never invokes or stringifies handlers', async () => {
    let invoked = false;
    const handler = Object.assign(
      () => {
        invoked = true;
      },
      {
        toString: () => {
          throw new Error('must not stringify');
        },
      },
    );
    const safeTool = tool({ commandSpecs: [{ ...command('alpha'), handler }] });
    const outcome = await port({ tools: [safeTool] }).query({ limit: 100 });
    expect(invoked).toBe(false);
    expect(outcome.ok).toBe(true);
  });

  it('bounds and sanitizes command text while marking coverage partial', async () => {
    const hostileName = `${'x'.repeat(300)}\u0000\u0085\u009Ftail`;
    const outcome = await port({
      tools: [tool({ commandSpecs: [{ ...command('alpha'), name: hostileName }] })],
    }).query({ limit: 100 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const commandNode = outcome.value.nodes.find((node) => node.kind === 'command');
    expect(commandNode?.label).toHaveLength(256);
    expect(commandNode?.label).not.toContain('\u0000');
    expect(commandNode?.label).not.toContain('\u0085');
    expect(commandNode?.label).not.toContain('\u009F');
    expect(outcome.value.coverage.complete).toBe(false);
    expect(outcome.value.coverage.reasons).toContain('text-cap-or-control-sanitization');
  });

  it('bounds a multi-megabyte command name without retaining a sanitized full-size copy', async () => {
    const outcome = await port({
      tools: [
        tool({
          commandSpecs: [{ ...command('alpha'), name: 'z'.repeat(2_000_000) }],
        }),
      ],
    }).query({ limit: 100 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const commandNode = outcome.value.nodes.find((node) => node.kind === 'command');
    expect(commandNode?.label).toBe('z'.repeat(256));
    expect(outcome.value.coverage).toMatchObject({
      complete: false,
      truncated: false,
    });
    expect(outcome.value.coverage.reasons).toContain('text-cap-or-control-sanitization');
  });

  it('stops inspecting control-only text at the text ceiling', async () => {
    const outcome = await port({
      tools: [
        tool({
          commandSpecs: [
            {
              ...command('alpha'),
              name: `${'\u0000'.repeat(2_000_000)}not-inspected`,
            },
          ],
        }),
      ],
    }).query({ limit: 100 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.nodes.some((node) => node.kind === 'command')).toBe(false);
    expect(outcome.value.coverage).toMatchObject({
      complete: false,
      truncated: false,
    });
    expect(outcome.value.coverage.reasons).toEqual(
      expect.arrayContaining([
        'command-spec-invalid-or-accessor',
        'text-cap-or-control-sanitization',
      ]),
    );
  });

  it('binds continuation cursors to project, snapshot, and normalized query', async () => {
    const first = await port().query({ limit: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.page.hasMore).toBe(true);
    expect(first.value.page.nextCursor).toBeTypeOf('string');
    const cursor = first.value.page.nextCursor!;
    const decodedCursor = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      afterKey: string;
    };
    const firstNodeId = first.value.nodes[0]?.id;
    expect(firstNodeId).toBeTypeOf('string');
    if (firstNodeId === undefined) return;
    expect(decodedCursor.afterKey).toMatch(/^r1:[a-f0-9]{64}$/u);
    expect(decodedCursor.afterKey).not.toContain(firstNodeId);

    const second = await port().query({ limit: 1, cursor });
    expect(
      second.ok,
      `${JSON.stringify(second)} ${Buffer.from(cursor, 'base64url').toString('utf8')}`,
    ).toBe(true);
    if (second.ok) expect(second.value.nodes[0]?.id).not.toBe(first.value.nodes[0]?.id);

    const wrongProject = await port({
      projectRoot: '/different/project',
    }).query({
      limit: 1,
      cursor,
    });
    expect(wrongProject).toMatchObject({
      ok: false,
      error: { code: 'cursor-project-mismatch' },
    });

    const changedTool = tool({
      commandSpecs: [command('alpha'), command('inspect', 'alpha'), command('new', 'alpha')],
    });
    const stale = await port({ tools: [changedTool] }).query({
      limit: 1,
      cursor,
    });
    expect(stale).toMatchObject({ ok: false, error: { code: 'cursor-stale' } });

    const changedQuery = await port().query({
      limit: 1,
      cursor,
      command: 'inspect',
    });
    expect(changedQuery).toMatchObject({
      ok: false,
      error: { code: 'cursor-query-mismatch' },
    });
    const malformed = await port().query({ limit: 1, cursor: 'not-base64!' });
    expect(malformed).toMatchObject({
      ok: false,
      error: { code: 'cursor-invalid' },
    });
  });

  it('stops hostile command surfaces at the immutable snapshot ceilings', async () => {
    const commands = Array.from({ length: 4000 }, (_, index) =>
      command(
        index === 0 ? 'alpha' : `command-${String(index)}`,
        index === 0 ? undefined : 'alpha',
      ),
    );
    const outcome = await port({
      tools: [tool({ commandSpecs: commands })],
    }).query({ limit: 500 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.coverage).toMatchObject({
      complete: false,
      truncated: true,
    });
    expect(outcome.value.coverage.reasons).toContain('node-cap');
    expect(outcome.value.nodes.length).toBeLessThanOrEqual(500);
  });

  it('caps duplicate admission facts that cannot reach the node ceiling', async () => {
    const repeatedManifest = manifest();
    const outcome = await port({
      manifests: Array.from({ length: MAX_RUNTIME_FACTS + 1 }, () => repeatedManifest),
    }).query({ limit: 500 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.coverage).toMatchObject({
      complete: false,
      truncated: true,
    });
    expect(outcome.value.coverage.reasons).toEqual(
      expect.arrayContaining(['duplicate-node-id', 'duplicate-tool-manifest', 'fact-cap']),
    );
    expect(outcome.value.nodes.filter((node) => node.kind === 'manifest')).toHaveLength(1);
  });

  it('caps duplicate command facts that cannot reach the node or edge ceilings', async () => {
    const repeatedCommand = command('alpha');
    const outcome = await port({
      tools: [
        tool({
          commandSpecs: Array.from({ length: MAX_RUNTIME_FACTS }, () => repeatedCommand),
        }),
      ],
      manifests: [],
      provenance: [],
    }).query({ limit: 500 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.coverage).toMatchObject({
      complete: false,
      truncated: true,
    });
    expect(outcome.value.coverage.reasons).toEqual(
      expect.arrayContaining(['duplicate-node-id', 'duplicate-edge-id', 'fact-cap']),
    );
    expect(outcome.value.nodes.length).toBeLessThan(10);
  });

  it('builds the complete related command path and reports the page edge cap', async () => {
    const commands = [
      command('alpha'),
      ...Array.from({ length: 10 }, (_, index) => command(`child-${String(index)}`, 'alpha')),
    ];
    const runtime = port({ tools: [tool({ commandSpecs: commands })] });
    const completePath = await runtime.query({ command: 'alpha', limit: 100 });
    expect(completePath.ok).toBe(true);
    if (!completePath.ok) return;
    expect([...new Set(completePath.value.nodes.map((node) => node.kind))]).toEqual(
      expect.arrayContaining([
        'manifest',
        'provenance',
        'tool',
        'command',
        'host-mount',
        'handler',
      ]),
    );

    const capped = await runtime.query({ command: 'alpha', limit: 1 });
    expect(capped.ok).toBe(true);
    if (!capped.ok) return;
    expect(capped.value.page.edgeTruncated).toBe(true);
    expect(capped.value.coverage).toMatchObject({
      complete: false,
      truncated: true,
    });
    expect(capped.value.coverage.reasons).toContain('page-edge-cap');
    expect(capped.value.edges).toHaveLength(4);
  });

  it('marks missing and unmatched admission facts as partial rather than guessing', async () => {
    const outcome = await port({ manifests: [], provenance: [] }).query({
      limit: 100,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.coverage.complete).toBe(false);
    expect(outcome.value.coverage.reasons).toEqual(
      expect.arrayContaining(['unmatched-tool-manifest', 'unmatched-tool-provenance']),
    );
  });

  it('caps grouped runtime keys at 500', async () => {
    const tools = Array.from({ length: 501 }, (_, index) => {
      const name = `tool-${String(index)}`;
      return tool({
        identity: { name },
        metadata: {
          id: `stable-${String(index)}`,
          name,
          version: '1.0.0',
          description: 'fixture',
        },
        commandSpecs: [command(name)],
      });
    });
    const manifests = tools.map((value): ToolPluginManifest => ({
      kind: 'tool',
      apiVersion: 1,
      id: value.identity.name,
      stableId: value.metadata.id,
      identity: value.identity,
      name: value.identity.name,
      version: value.metadata.version,
      commands: [],
    }));
    const provenanceRows = tools.map((value): ToolProvenance => ({
      source: 'bundled',
      id: value.identity.name,
      stableId: value.metadata.id,
      version: value.metadata.version,
      manifestHash: 'private',
    }));
    const outcome = await port({
      tools,
      manifests,
      provenance: provenanceRows,
    }).query({
      groupBy: 'tool',
      limit: 1,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.groups).toHaveLength(500);
    expect(outcome.value.groupTruncated).toBe(true);
    expect(outcome.value.coverage.truncated).toBe(true);
    expect(outcome.value.coverage.reasons).toContain('group-key-cap');
  });
});
