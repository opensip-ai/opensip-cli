import {
  createRuntimeCommandInventory,
  ToolRegistry,
  type RuntimeCommandInventory,
  type RuntimeCommandLeaf,
  type Tool,
  type ToolPluginManifest,
  type ToolProvenance,
} from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { LiveRuntimeWiringReadPort } from '../live-runtime-wiring-read-port.js';

import type { RuntimeWiringQuery } from '../runtime-wiring-read-port.js';
import type { ResolveStaticHandlers } from '../static-handler-bridge.js';

const STABLE_ID = '11111111-1111-4111-8111-111111111111';

function tool(overrides: Partial<Tool> = {}): Tool {
  return {
    identity: { name: 'alpha', aliases: ['a'], layoutKey: 'alpha-layout' },
    metadata: {
      id: STABLE_ID,
      name: 'alpha',
      version: '1.2.3',
      description: 'fixture',
    },
    // Live commandSpecs are ignored for command projection — inventory is the source.
    commandSpecs: [],
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

function leaf(overrides: Partial<RuntimeCommandLeaf> = {}): RuntimeCommandLeaf {
  return {
    path: 'alpha',
    name: 'alpha',
    aliases: [],
    owner: 'tool',
    ownerLabel: 'alpha',
    visibility: 'public',
    scope: 'project',
    output: 'command-result',
    packageIdentity: '@fixture/alpha',
    provenanceSource: 'bundled',
    staticHandler: {
      package: '@fixture/alpha',
      path: 'packages/alpha/src/cmd.ts',
      declaration: 'alphaHandler',
    },
    ...overrides,
  };
}

function inventory(
  leaves: readonly RuntimeCommandLeaf[] = [
    leaf(),
    leaf({
      path: 'alpha inspect',
      name: 'inspect',
      staticHandler: {
        package: '@fixture/alpha',
        path: 'packages/alpha/src/inspect.ts',
        declaration: 'inspectHandler',
      },
    }),
  ],
  groups: RuntimeCommandInventory['groups'] = [],
): RuntimeCommandInventory {
  return createRuntimeCommandInventory({ leaves, groups, complete: true });
}

function port(
  options: {
    readonly projectRoot?: string;
    readonly configPath?: string;
    readonly tools?: readonly Tool[];
    readonly manifests?: readonly ToolPluginManifest[];
    readonly provenance?: readonly ToolProvenance[];
    readonly runtimeCommands?: RuntimeCommandInventory;
    readonly resolveStaticHandlers?: ResolveStaticHandlers;
  } = {},
): LiveRuntimeWiringReadPort {
  const registry = new ToolRegistry();
  for (const value of options.tools ?? [tool()]) registry.register(value);
  return new LiveRuntimeWiringReadPort({
    projectRoot: options.projectRoot ?? '/fixture/project',
    configPath: options.configPath ?? 'opensip-cli.config.yml',
    tools: registry,
    manifests: options.manifests ?? [manifest()],
    provenance: options.provenance ?? [provenance()],
    runtimeCommands: options.runtimeCommands ?? inventory(),
    ...(options.resolveStaticHandlers === undefined
      ? {}
      : { resolveStaticHandlers: options.resolveStaticHandlers }),
  });
}

describe('LiveRuntimeWiringReadPort', () => {
  it('reports the selected absolute config path relative to the project', async () => {
    const outcome = await port({
      configPath: '/fixture/project/config/custom-opensip.yml',
    }).query({ detail: 'summary' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.context.project.configPath).toBe('config/custom-opensip.yml');
  });

  it('does not misreport an absolute config outside the project as the default config', async () => {
    const outcome = await port({
      configPath: '/fixture/other/custom-opensip.yml',
    }).query({ detail: 'summary' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.context.project.configPath).toBe('<outside-project>');
  });

  it('returns deterministic repeated projections from one immutable snapshot', async () => {
    const runtime = port();
    const first = await runtime.query({ detail: 'nodes', groupBy: 'none', limit: 100 });
    const second = await runtime.query({ detail: 'nodes', groupBy: 'none', limit: 100 });
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
      runtimeCommands: inventory(),
    });

    await runtime.query({ tool: 'a', detail: 'nodes', limit: 100 });
    await runtime.query({ tool: 'alpha-layout', detail: 'nodes', limit: 100 });

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

  it('projects admitted manifest, registry, nesting, mount, and handler evidence from inventory', async () => {
    const outcome = await port().query({ detail: 'nodes', limit: 100 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.context.project.root).toBe('/fixture/project');
    expect(outcome.value.context.project.scope).toBe('project');
    expect(outcome.value.context.runtime.identity).toMatch(/^w1:/);
    expect(outcome.value.context.projectKey).not.toContain('/fixture/project');
    expect(outcome.value.coverage).toMatchObject({
      complete: true,
      scope: 'captured-admitted-registry-and-command-inventory',
      truncated: false,
    });
    expect(outcome.value.coverage.reasons).not.toContain('top-level-host-commands-outside-port');
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
  });

  it('includes host commands from inventory without inventing a Tool owner', async () => {
    const inv = inventory(
      [
        leaf({
          path: 'init',
          name: 'init',
          owner: 'host',
          ownerLabel: 'cli',
          packageIdentity: undefined,
          provenanceSource: undefined,
          staticHandler: {
            package: 'opensip-cli',
            path: 'packages/cli/src/commands/host-command-specs.ts',
            declaration: 'handleInit',
          },
        }),
      ],
      [
        {
          path: 'sessions',
          name: 'sessions',
          owner: 'host',
          ownerLabel: 'cli',
          visibility: 'public',
        },
      ],
    );
    const outcome = await port({ runtimeCommands: inv }).query({ detail: 'nodes', limit: 100 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.nodes).toContainEqual(
      expect.objectContaining({ kind: 'command', owner: 'host', commandPath: 'init' }),
    );
    expect(outcome.value.nodes).toContainEqual(
      expect.objectContaining({ kind: 'command-group', commandPath: 'sessions' }),
    );
    expect(
      outcome.value.edges.every(
        (edge) => edge.kind !== 'registry-owns-command' || !edge.to.includes('init'),
      ),
    ).toBe(true);
  });

  it('defaults to exclusive summary detail with counts only', async () => {
    const outcome = await port().query({});
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.effectiveFilters.detail).toBe('summary');
    expect(outcome.value.nodes).toEqual([]);
    expect(outcome.value.edges).toEqual([]);
    expect(outcome.value.summary).toMatchObject({
      toolCount: 1,
      commandCount: expect.any(Number),
      handlerCount: expect.any(Number),
    });
  });

  it('pages groups without nodes when detail=groups', async () => {
    const outcome = await port().query({ detail: 'groups', groupBy: 'tool', limit: 100 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.nodes).toEqual([]);
    expect(outcome.value.groups).toContainEqual({ key: 'alpha', count: expect.any(Number) });
  });

  it('honors limit and cursor when paging grouped runtime wiring', async () => {
    const runtime = port();
    const first = await runtime.query({ detail: 'groups', groupBy: 'source', limit: 1 });

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.groups).toHaveLength(1);
    expect(first.value.page.hasMore).toBe(true);
    expect(first.value.page.nextCursor).toBeTypeOf('string');

    const second = await runtime.query({
      detail: 'groups',
      groupBy: 'source',
      limit: 1,
      cursor: first.value.page.nextCursor,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.groups).toHaveLength(1);
    expect(second.value.groups?.[0]?.key).not.toBe(first.value.groups?.[0]?.key);
  });

  it('rejects detail=groups without groupBy', async () => {
    const outcome = await port().query({ detail: 'groups' });
    expect(outcome).toMatchObject({ ok: false, error: { code: 'invalid-query' } });
  });

  it('resolves aliases/layout keys and groups by tool or provenance source', async () => {
    const byAlias = await port().query({
      tool: 'a',
      detail: 'groups',
      groupBy: 'tool',
      limit: 100,
    });
    expect(byAlias.ok).toBe(true);
    if (!byAlias.ok) return;
    expect(byAlias.value.effectiveFilters.tool).toBe('alpha');
    expect(byAlias.value.groups).toContainEqual({
      key: 'alpha',
      count: expect.any(Number),
    });

    const bySource = await port().query({
      tool: 'alpha-layout',
      provenanceSource: 'bundled',
      detail: 'nodes',
      limit: 100,
    });
    expect(bySource.ok).toBe(true);
    if (!bySource.ok) return;
    expect(bySource.value.nodes.length).toBeGreaterThan(0);
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
    }).query({ detail: 'nodes', limit: 100 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'worker-posture',
        workerPosture: 'isolated-worker-proxy',
        provenanceSource: 'project-local',
      }),
    );
    expect(JSON.stringify(outcome.value)).not.toMatch(/private-hash|\/private\/external/);
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
    }).query({ detail: 'nodes', limit: 100 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.coverage).toMatchObject({ complete: false, truncated: false });
    expect(outcome.value.coverage.reasons).toContain('tool-identity-invalid-or-accessor');
    expect(outcome.value.nodes.some((node) => node.kind === 'tool')).toBe(false);
  });

  it('never retains live handlers and never stringifies them', async () => {
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
    // Even if tools carry live handlers, inventory projection ignores them.
    const outcome = await port({
      tools: [
        tool({
          commandSpecs: [
            {
              name: 'alpha',
              description: 'x',
              commonFlags: [],
              scope: 'project',
              output: 'command-result',
              handler,
            },
          ],
        }),
      ],
      runtimeCommands: inventory([leaf()]),
    }).query({ detail: 'nodes', limit: 100 });
    expect(invoked).toBe(false);
    expect(outcome.ok).toBe(true);
  });

  it('stable w1 identity excludes capturedAt volatility', async () => {
    const a = await port().query({ detail: 'summary' });
    const b = await port().query({ detail: 'summary' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.context.runtime.identity).toBe(b.value.context.runtime.identity);
  });

  it('changes w1 identity when captured alias or version metadata changes', async () => {
    const base = await port().query({ detail: 'summary' });
    const aliasChanged = await port({
      tools: [
        tool({
          identity: { name: 'alpha', aliases: ['renamed'], layoutKey: 'alpha-layout' },
        }),
      ],
    }).query({ detail: 'summary' });
    const versionChanged = await port({
      provenance: [provenance({ version: '9.9.9' })],
    }).query({ detail: 'summary' });

    expect(base.ok && aliasChanged.ok && versionChanged.ok).toBe(true);
    if (!base.ok || !aliasChanged.ok || !versionChanged.ok) return;
    expect(aliasChanged.value.context.runtime.identity).not.toBe(
      base.value.context.runtime.identity,
    );
    expect(versionChanged.value.context.runtime.identity).not.toBe(
      base.value.context.runtime.identity,
    );
  });

  it('does not claim a complete static bridge when every handler lacks metadata', async () => {
    const resolveStaticHandlers = vi.fn<ResolveStaticHandlers>();
    const outcome = await port({
      runtimeCommands: inventory([leaf({ staticHandler: undefined })]),
      resolveStaticHandlers,
    }).query({ detail: 'summary' });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(resolveStaticHandlers).not.toHaveBeenCalled();
    expect(outcome.value.coverage.staticBridgeComplete).toBe(false);
    expect(outcome.value.summary?.unresolvedBridgeCount).toBe(1);
  });

  it('overlays resolved static handler bridges via injected resolver', async () => {
    const resolveStaticHandlers: ResolveStaticHandlers = async (_key, refs) => {
      await Promise.resolve();
      return {
        catalogStatus: 'loaded',
        catalogIdentity: `g1:${'b'.repeat(64)}`,
        outcomes: refs.map((ref) => ({
          ref,
          status: 'resolved' as const,
          declarationId: `d1:${ref.declaration}`,
          declarationQualifiedName: ref.declaration,
          claimProvenance: 'author-declared' as const,
          matchBasis: 'author-declared-exact-declaration' as const,
          confidence: 'medium' as const,
        })),
      };
    };
    const outcome = await port({ resolveStaticHandlers }).query({ detail: 'nodes', limit: 100 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.nodes).toContainEqual(
      expect.objectContaining({
        kind: 'handler',
        declarationId: expect.stringMatching(/^d1:/),
      }),
    );
    expect(outcome.value.edges).toContainEqual(
      expect.objectContaining({
        kind: 'command-dispatches-handler',
        staticBridge: 'resolved',
        matchBasis: 'author-declared-exact-declaration',
      }),
    );
  });

  it('resolves each command by its own provenance even when two commands share a static-handler descriptor triple', async () => {
    // Two commands claim the exact same {package, path, declaration} static
    // handler, but with different packageIdentity — one is legitimately
    // owned by that package, the other impersonates it. The dedup/broadcast
    // key used to route batch outcomes back onto command paths must include
    // provenance (owner + admittedPackageIdentity), or the impersonator
    // silently inherits whichever outcome the legitimate command receives
    // (or vice versa) instead of failing its own preflight check.
    const sharedHandler = {
      package: '@fixture/alpha',
      path: 'packages/alpha/src/cmd.ts',
      declaration: 'sharedHandler',
    };
    const legitLeaf = leaf({
      path: 'alpha legit',
      name: 'legit',
      packageIdentity: '@fixture/alpha',
      staticHandler: sharedHandler,
    });
    const impersonatorLeaf = leaf({
      path: 'alpha evil',
      name: 'evil',
      packageIdentity: '@evil/other',
      staticHandler: sharedHandler,
    });
    const resolveStaticHandlers: ResolveStaticHandlers = async (_key, refs) => {
      await Promise.resolve();
      return {
        catalogStatus: 'loaded',
        catalogIdentity: `g1:${'b'.repeat(64)}`,
        outcomes: refs.map((ref) => {
          if (ref.owner === 'tool' && ref.package !== ref.admittedPackageIdentity) {
            return {
              ref,
              status: 'provenance-mismatch' as const,
              claimProvenance: 'author-declared' as const,
              matchBasis: 'author-declared-exact-declaration' as const,
              confidence: 'low' as const,
              reason: 'claimed-package-differs-from-admitted-plugin-identity',
            };
          }
          return {
            ref,
            status: 'resolved' as const,
            declarationId: `d1:${ref.declaration}`,
            declarationQualifiedName: ref.declaration,
            claimProvenance: 'author-declared' as const,
            matchBasis: 'author-declared-exact-declaration' as const,
            confidence: 'medium' as const,
          };
        }),
      };
    };

    const outcome = await port({
      resolveStaticHandlers,
      runtimeCommands: inventory([legitLeaf, impersonatorLeaf]),
    }).query({ detail: 'nodes', limit: 100 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const legitEdge = outcome.value.edges.find(
      (e) => e.kind === 'command-dispatches-handler' && e.from.includes('legit'),
    );
    const evilEdge = outcome.value.edges.find(
      (e) => e.kind === 'command-dispatches-handler' && e.from.includes('evil'),
    );
    expect(legitEdge).toMatchObject({ staticBridge: 'resolved' });
    expect(evilEdge).toMatchObject({
      staticBridge: 'unresolved',
      reason: 'claimed-package-differs-from-admitted-plugin-identity',
    });
  });

  it('binds continuation cursors to project, w1 snapshot, and normalized query', async () => {
    // Same port instance = same immutable w1 snapshot (cursor generationKey).
    const runtime = port();
    const first = await runtime.query({ detail: 'nodes', limit: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.page.hasMore).toBe(true);
    expect(first.value.page.nextCursor).toBeTypeOf('string');
    const cursor = first.value.page.nextCursor!;
    const second = await runtime.query({ detail: 'nodes', limit: 1, cursor });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.nodes[0]?.id).not.toBe(first.value.nodes[0]?.id);
  });
});
