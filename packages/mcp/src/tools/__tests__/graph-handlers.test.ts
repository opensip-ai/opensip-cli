/**
 * Graph tool handlers vs. a FAKE async `GraphReadPort` (Phase 1 cutover).
 */

import { err, ok, type Result } from '@opensip-cli/core';
import { makeFacet, rollupFacets, UNREQUESTED_FACET } from '@opensip-cli/graph/read';
import { describe, expect, it, vi } from 'vitest';

import {
  registerBlastRadius,
  registerCalleesOf,
  registerFindDeadCode,
  registerGetArchitecture,
  registerGetRuntimeWiring,
  registerGetSymbol,
  registerPackageCycles,
  registerPackageDependencies,
  registerReferencesTo,
  registerSearchDeclarations,
  registerSearchSymbols,
  registerTracePath,
  registerWhoCalls,
  registerWhyDepends,
} from './_graph-handler-registrations.js';

import type {
  ArchitectureSummaryDto,
  BlastDto,
  DeadCodeResultDto,
  GraphReadPort,
  RefreshResult,
  SymbolSearchDto,
  TraversalSnapshot,
} from '../../graph-read-port.js';
import type { McpReadError } from '../../mcp-error.js';
import type { RuntimeWiringReadPort } from '../../runtime-wiring-read-port.js';
import type { CallToolResult, McpStdioServer } from '../../server.js';
import type {
  Freshness,
  GraphEvidenceContext,
  GraphToolResult,
  SymbolRef,
} from '../../symbol-dto.js';
import type { McpToolDeps } from '../types.js';

type Handler = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

function captureServer(): {
  configs: Map<string, unknown>;
  handlers: Map<string, Handler>;
  server: McpStdioServer;
} {
  const configs = new Map<string, unknown>();
  const handlers = new Map<string, Handler>();
  const server = {
    register: (name: string, config: unknown, cb: Handler) => {
      configs.set(name, config);
      handlers.set(name, cb);
    },
  } as unknown as McpStdioServer;
  return { configs, handlers, server };
}

function parseResult(result: CallToolResult): { isError: boolean; body: Record<string, unknown> } {
  const first = result.content[0];
  const text = first?.type === 'text' ? first.text : '';
  return { isError: result.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

const FRESH: Freshness = {
  fresh: true,
  builtAt: '2026-05-22T00:00:00.000Z',
  verifiedAt: '2026-05-22T00:00:01.000Z',
  verification: 'complete',
};

const CONTEXT: GraphEvidenceContext = {
  project: { root: '/proj', scope: 'project', configPath: 'opensip-cli.config.yml' },
  catalog: {
    status: 'loaded',
    builtAt: '2026-05-22T00:00:00.000Z',
    language: 'typescript',
    identity: 'g1:abc',
    loadedAt: '2026-05-22T00:00:00.000Z',
    generationSource: 'initial-load',
  },
};

const COVERAGE = rollupFacets({
  inventory: makeFacet(true, new Set()),
  evidence: UNREQUESTED_FACET,
  grouping: UNREQUESTED_FACET,
  projection: UNREQUESTED_FACET,
});

function wrap<T>(data: T): GraphToolResult<T> {
  return { data, context: CONTEXT, freshness: FRESH, coverage: COVERAGE };
}

function symRef(over: Partial<SymbolRef> = {}): SymbolRef {
  return {
    symbolId: 'src/a.ts:10:2',
    bodyHash: 'h-a',
    simpleName: 'a',
    qualifiedName: 'a',
    filePath: 'src/a.ts',
    line: 10,
    column: 2,
    kind: 'function-declaration',
    visibility: 'exported',
    package: 'pkg',
    inTestFile: false,
    definedInGenerated: false,
    ...over,
  };
}

function searchDto(symbols: readonly SymbolRef[] = [symRef()]): SymbolSearchDto {
  return { detail: 'nodes', symbols, totalMatches: symbols.length };
}

function fakePort(overrides: Partial<GraphReadPort> = {}): GraphReadPort {
  const base: GraphReadPort = {
    catalogStatus: () => Promise.resolve(ok({ context: CONTEXT, freshness: FRESH })),
    resolveSymbolId: (id) =>
      Promise.resolve(ok(wrap(id === 'src/a.ts:10:2' ? symRef() : undefined))),
    searchSymbols: () => Promise.resolve(ok(wrap(searchDto()))),
    findBySpan: () => Promise.resolve(ok(wrap([symRef()] as readonly SymbolRef[]))),
    symbolAtLocation: () =>
      Promise.resolve(ok(wrap({ candidates: [symRef()] as readonly SymbolRef[] }))),
    impactFiles: () => Promise.resolve(ok(wrap({} as never))),
    entityDetail: () => Promise.resolve(ok(wrap(null))),
    selectTests: () => Promise.resolve(ok(wrap({} as never))),
    contextPointerStatus: (pointer) =>
      Promise.resolve(ok({ pointer, status: 'available' as const, reasonCodes: [] })),
    traverse: (query) => {
      const nodes = [
        { symbol: symRef(), depth: 0, groupId: 'src/a.ts:10:2', groupTotal: 1 },
        {
          symbol: symRef({ symbolId: 'src/b.ts:1:0' }),
          depth: 1,
          groupId: 'src/b.ts:1:0',
          groupTotal: 1,
        },
      ];
      const data: TraversalSnapshot = {
        found: true,
        nodes,
        path: query.direction === 'path' ? nodes.map((n) => n.symbol) : undefined,
        identityMode: query.identity ?? 'occurrence',
        totalMembership: nodes.length,
        counts: {
          includedOccurrences: nodes.length,
          excludedOccurrences: 0,
          includedEdges: 1,
          excludedEdges: 0,
          countScope: 'visited',
        },
        unresolved: [],
        unresolvedCounts: [],
        unresolvedAttribution: 'owner-only',
      };
      return Promise.resolve(ok(wrap(data)));
    },
    blast: () =>
      Promise.resolve(
        ok(
          wrap({
            symbol: symRef(),
            members: [symRef()],
            totalMembership: 1,
            direct: 2,
            transitive: 4,
            score: 4,
            identityMode: 'body-twin-union',
          } satisfies BlastDto),
        ),
      ),
    deadCode: () =>
      Promise.resolve(
        ok(
          wrap({
            detail: 'summary',
            rows: [],
            totalOrphans: 1,
            reasonCounts: [{ reason: 'unreachable-from-inferred-entry-point', count: 1 }],
            ruleCounts: [{ ruleId: 'graph:orphan-subtree', count: 1 }],
          } satisfies DeadCodeResultDto),
        ),
      ),
    architectureSummary: () =>
      Promise.resolve(
        ok(
          wrap({
            languages: ['typescript'],
            occurrenceCount: {
              value: 1,
              nodeIdentity: 'occurrence',
              sourceScope: 'production',
              generated: 'exclude',
            },
            uniqueBodyCount: {
              value: 1,
              nodeIdentity: 'body-hash',
              sourceScope: 'production',
              generated: 'exclude',
            },
            callEvidence: {
              resolvedCallSites: 1,
              resolvedTargets: 1,
              unresolvedCallSites: 0,
              confidence: { high: 1 },
              resolution: { static: 1 },
              distributionCountUnit: 'resolved-targets-plus-unresolved-call-sites',
              resolvedTargetConfidence: {
                values: { high: 1 },
                countUnit: 'resolved-targets',
              },
              resolvedTargetResolution: {
                values: { static: 1 },
                countUnit: 'resolved-targets',
              },
              unresolvedCallSiteConfidence: {
                values: {},
                countUnit: 'unresolved-call-sites',
              },
              unresolvedCallSiteResolution: {
                values: {},
                countUnit: 'unresolved-call-sites',
              },
              nodeIdentity: 'occurrence',
              sourceScope: 'production',
              generated: 'exclude',
              edgeKind: 'call',
              catalogResolutionMode: 'exact',
            },
            packageCount: {
              value: 1,
              nodeIdentity: 'package',
              sourceScope: 'production',
              generated: 'exclude',
            },
            includedSections: ['metrics', 'packageEdges', 'hotspots'],
            packageEdges: [
              {
                fromPackage: 'pkg',
                toPackage: 'other',
                kind: 'call',
                count: 1,
                countUnit: 'resolved-targets',
                nodeIdentity: 'package',
                sourceScope: 'production',
                generated: 'exclude',
                catalogResolutionMode: 'exact',
              },
            ],
            hotspots: [],
          } satisfies ArchitectureSummaryDto),
        ),
      ),
    refresh: () =>
      Promise.resolve(
        ok(
          wrap({
            generation: { builtAt: FRESH.builtAt!, identity: 'g1:abc' },
            action: 'rebuilt',
            durationMs: 1,
            priorGenerationAvailable: false,
          } satisfies RefreshResult),
        ),
      ),
    packageDependencies: () =>
      Promise.resolve(ok(wrap({ edgeKind: 'call', calls: [], imports: [] }))),
    whyDepends: () =>
      Promise.resolve(
        ok(wrap({ edgeKind: 'combined', calls: [], imports: [], totalMatchingEvidence: 0 })),
      ),
    packageCycles: () => Promise.resolve(ok(wrap({ edgeKind: 'call', components: [] }))),
    searchDeclarations: () =>
      Promise.resolve(
        ok(
          wrap({
            detail: 'nodes',
            referenceScope: 'cross-file',
            declarations: [],
            totalMatches: 0,
          }),
        ),
      ),
    referencesTo: () =>
      Promise.resolve(
        ok(
          wrap({
            detail: 'nodes',
            referenceScope: 'cross-file',
            declarationId: 'd1:none',
            references: [],
            totalMatches: 0,
          }),
        ),
      ),
    resolveStaticHandlerDeclarations: (_key, refs) =>
      Promise.resolve(
        ok({
          catalogStatus: 'missing' as const,
          outcomes: refs.map((ref) => ({
            ref,
            status: 'catalog-missing' as const,
            claimProvenance: 'author-declared' as const,
            matchBasis: 'author-declared-exact-declaration' as const,
            confidence: 'low' as const,
          })),
        }),
      ),
  };
  return { ...base, ...overrides };
}

function deps(graph: GraphReadPort): McpToolDeps {
  return {
    graph,
    codebase: {} as McpToolDeps['codebase'],
    context: {} as McpToolDeps['context'],
    results: {} as McpToolDeps['results'],
    runtimeWiring: {} as McpToolDeps['runtimeWiring'],
    validToolIds: new Set(['fit', 'graph']),
  };
}

describe('graph handlers (async GraphToolResult)', () => {
  it('search_symbols returns context + freshness envelope', async () => {
    const { handlers, server } = captureServer();
    registerSearchSymbols(server, deps(fakePort()));
    const result = await handlers.get('search_symbols')!({ query: 'a' });
    const parsed = parseResult(result);
    expect(parsed.isError).toBe(false);
    expect(parsed.body).toMatchObject({
      context: CONTEXT,
      freshness: FRESH,
      coverage: COVERAGE,
      data: { detail: 'nodes', symbols: [expect.objectContaining({ symbolId: 'src/a.ts:10:2' })] },
    });
    expect(Array.isArray((parsed.body.data as { symbols: unknown }).symbols)).toBe(true);
  });

  it('search_declarations and references_to project envelopes', async () => {
    {
      const { handlers, server } = captureServer();
      registerSearchDeclarations(server, deps(fakePort()));
      const parsed = parseResult(await handlers.get('search_declarations')!({ query: 'Foo' }));
      expect(parsed.isError).toBe(false);
      expect(parsed.body).toMatchObject({
        context: CONTEXT,
        data: { detail: 'nodes', referenceScope: 'cross-file' },
      });
    }
    {
      const { handlers, server } = captureServer();
      registerReferencesTo(server, deps(fakePort()));
      const parsed = parseResult(
        await handlers.get('references_to')!({ declarationId: 'd1|none' }),
      );
      expect(parsed.isError).toBe(false);
      expect(parsed.body).toMatchObject({
        data: { detail: 'nodes', referenceScope: 'cross-file' },
      });
    }
    {
      const referencesTo = vi.fn(() =>
        Promise.resolve(
          ok(
            wrap({
              detail: 'summary' as const,
              referenceScope: 'cross-file' as const,
              declarationId: 'd1|Foo',
              references: [],
              totalMatches: 0,
            }),
          ),
        ),
      );
      const graph = fakePort({ referencesTo });
      const { handlers, server } = captureServer();
      registerReferencesTo(server, deps(graph));
      const parsed = parseResult(
        await handlers.get('references_to')!({
          declarationId: 'd1|Foo',
          kinds: ['type', 'import'],
          packages: ['pkg'],
          filePath: 'src/a.ts',
          filePrefix: 'src/',
          sourceScope: 'production',
          generated: 'include',
          limit: 10,
        }),
      );
      expect(parsed.isError).toBe(false);
      expect(referencesTo).toHaveBeenCalledWith('d1|Foo', {
        kinds: ['type', 'import'],
        limit: 10,
        cursor: undefined,
        groupBy: undefined,
        detail: 'summary',
        filter: {
          packages: ['pkg'],
          filePath: 'src/a.ts',
          filePrefix: 'src/',
          sourceScope: 'production',
          generated: 'include',
        },
      });
    }
    {
      const graph = fakePort({
        searchDeclarations: () => Promise.resolve(err({ code: 'invalid-query', message: 'bad' })),
      });
      const { handlers, server } = captureServer();
      registerSearchDeclarations(server, deps(graph));
      expect(parseResult(await handlers.get('search_declarations')!({ query: 'x' })).isError).toBe(
        true,
      );
    }
    {
      const graph = fakePort({
        referencesTo: () => Promise.resolve(err({ code: 'not-found', message: 'missing' })),
      });
      const { handlers, server } = captureServer();
      registerReferencesTo(server, deps(graph));
      expect(
        parseResult(await handlers.get('references_to')!({ declarationId: 'd1|missing' })).isError,
      ).toBe(true);
    }
  });

  it('get_symbol returns candidates with context', async () => {
    const { handlers, server } = captureServer();
    registerGetSymbol(server, deps(fakePort()));
    const result = await handlers.get('get_symbol')!({ file: 'src/a.ts', line: 10 });
    const parsed = parseResult(result);
    expect(parsed.isError).toBe(false);
    expect(parsed.body.context).toEqual(CONTEXT);
  });

  it('get_symbol reports not-found, stale not-found, and ambiguity', async () => {
    {
      const { handlers, server } = captureServer();
      registerGetSymbol(
        server,
        deps(
          fakePort({
            symbolAtLocation: () => Promise.resolve(ok(wrap({ candidates: [] }))),
          }),
        ),
      );
      const parsed = parseResult(
        await handlers.get('get_symbol')!({ file: 'src/missing.ts', line: 1 }),
      );
      expect(parsed.isError).toBe(false);
      expect(parsed.body).toMatchObject({
        found: false,
        error: { code: 'symbol-not-found' },
      });
      expect(String((parsed.body.error as { message: string }).message)).toContain(
        'search_symbols',
      );
    }
    {
      const staleFreshness = { ...FRESH, fresh: false };
      const { handlers, server } = captureServer();
      registerGetSymbol(
        server,
        deps(
          fakePort({
            symbolAtLocation: () =>
              Promise.resolve(
                ok({
                  data: { candidates: [] },
                  context: CONTEXT,
                  freshness: staleFreshness,
                  coverage: COVERAGE,
                }),
              ),
          }),
        ),
      );
      const parsed = parseResult(
        await handlers.get('get_symbol')!({ file: 'src/missing.ts', line: 1 }),
      );
      expect(String((parsed.body.error as { message: string }).message)).toContain('refresh_graph');
    }
    {
      const { handlers, server } = captureServer();
      registerGetSymbol(
        server,
        deps(
          fakePort({
            symbolAtLocation: () =>
              Promise.resolve(
                ok(
                  wrap({
                    candidates: [
                      symRef(),
                      symRef({ symbolId: 'src/a.ts:12:0' }),
                    ] as readonly SymbolRef[],
                  }),
                ),
              ),
          }),
        ),
      );
      const parsed = parseResult(await handlers.get('get_symbol')!({ file: 'src/a.ts', line: 10 }));
      expect(parsed.body).toMatchObject({ ambiguous: true });
      expect(Array.isArray(parsed.body.candidates)).toBe(true);
    }
  });

  it('who_calls and callees_of await traverse', async () => {
    const { handlers, server } = captureServer();
    registerWhoCalls(server, deps(fakePort()));
    registerCalleesOf(server, deps(fakePort()));
    for (const name of ['who_calls', 'callees_of'] as const) {
      const result = await handlers.get(name)!({ symbolId: 'src/a.ts:10:2', depth: 2 });
      const parsed = parseResult(result);
      expect(parsed.isError).toBe(false);
      expect(parsed.body.context).toEqual(CONTEXT);
      expect(parsed.body.coverage).toBeDefined();
      expect(parsed.body).not.toHaveProperty('truncated');
    }
  });

  it('surfaces graph port failures from walk, path, dead-code, and blast tools', async () => {
    const failure = err({
      code: 'catalog-missing',
      message: 'no catalog',
    });
    const port = fakePort({
      traverse: () => Promise.resolve(failure),
      deadCode: () => Promise.resolve(failure),
      blast: () => Promise.resolve(failure),
    });
    const { handlers, server } = captureServer();
    registerWhoCalls(server, deps(port));
    registerTracePath(server, deps(port));
    registerFindDeadCode(server, deps(port));
    registerBlastRadius(server, deps(port));
    for (const [name, args] of [
      ['who_calls', { symbolId: 'src/a.ts:10:2' }],
      ['trace_path', { fromSymbolId: 'src/a.ts:10:2', toSymbolId: 'src/b.ts:1:0' }],
      ['find_dead_code', { limit: 10 }],
      ['blast_radius', { symbolId: 'src/a.ts:10:2' }],
    ] as const) {
      const parsed = parseResult(await handlers.get(name)!(args));
      expect(parsed.isError).toBe(true);
    }
  });

  it('trace_path returns path envelope without top-level truncated', async () => {
    const { handlers, server } = captureServer();
    registerTracePath(server, deps(fakePort()));
    const result = await handlers.get('trace_path')!({
      fromSymbolId: 'src/a.ts:10:2',
      toSymbolId: 'src/b.ts:1:0',
      depth: 3,
    });
    const parsed = parseResult(result);
    expect(parsed.isError).toBe(false);
    expect(parsed.body).toMatchObject({
      data: { found: true },
      context: CONTEXT,
    });
    expect(parsed.body).not.toHaveProperty('truncated');
  });

  it('blast_radius labels identity mode', async () => {
    const { handlers, server } = captureServer();
    registerBlastRadius(server, deps(fakePort()));
    const result = await handlers.get('blast_radius')!({ symbolId: 'src/a.ts:10:2' });
    const parsed = parseResult(result);
    expect(parsed.isError).toBe(false);
    const data = parsed.body.data as Record<string, unknown>;
    expect(data.identityMode).toBe('body-twin-union');
  });

  it('blast_radius reports unavailable for missing scores (fresh and stale)', async () => {
    {
      const { handlers, server } = captureServer();
      registerBlastRadius(
        server,
        deps(
          fakePort({
            blast: () => Promise.resolve(ok(wrap(undefined as unknown as BlastDto))),
          }),
        ),
      );
      const parsed = parseResult(
        await handlers.get('blast_radius')!({ symbolId: 'src/missing.ts:1:0' }),
      );
      expect(parsed.body).toMatchObject({
        found: false,
        data: null,
        error: { code: 'blast-unavailable' },
      });
      expect(String((parsed.body.error as { message: string }).message)).toContain(
        'search_symbols',
      );
    }
    {
      const { handlers, server } = captureServer();
      registerBlastRadius(
        server,
        deps(
          fakePort({
            blast: () =>
              Promise.resolve(
                ok({
                  data: undefined,
                  context: CONTEXT,
                  freshness: { ...FRESH, fresh: false },
                  coverage: COVERAGE,
                }),
              ),
          }),
        ),
      );
      const parsed = parseResult(
        await handlers.get('blast_radius')!({ symbolId: 'src/missing.ts:1:0' }),
      );
      expect(String((parsed.body.error as { message: string }).message)).toContain('refresh_graph');
    }
  });

  it('find_dead_code and get_architecture await async port', async () => {
    const { handlers, server } = captureServer();
    registerFindDeadCode(server, deps(fakePort()));
    registerGetArchitecture(server, deps(fakePort()));
    const dead = parseResult(await handlers.get('find_dead_code')!({ limit: 10 }));
    const arch = parseResult(await handlers.get('get_architecture')!({ limit: 10 }));
    expect(dead.isError).toBe(false);
    expect(arch.isError).toBe(false);
    expect(dead.body.context).toEqual(CONTEXT);
    expect(arch.body.context).toEqual(CONTEXT);
    const archData = arch.body.data as Record<string, unknown>;
    expect(archData.occurrenceCount).toBeDefined();
    expect(archData.uniqueBodyCount).toBeDefined();
    expect(archData.callEvidence).toBeDefined();
    expect(archData.packageEdges).toBeDefined();
  });

  it('get_architecture surfaces port failures', async () => {
    const { handlers, server } = captureServer();
    registerGetArchitecture(
      server,
      deps(
        fakePort({
          architectureSummary: () =>
            Promise.resolve(err({ code: 'catalog-missing', message: 'none' })),
        }),
      ),
    );
    const parsed = parseResult(await handlers.get('get_architecture')!({ limit: 10 }));
    expect(parsed.isError).toBe(true);
  });

  it('get_architecture injects target conventions without changing graph metrics', async () => {
    const { handlers, server } = captureServer();
    const graph = fakePort();
    registerGetArchitecture(server, {
      ...deps(graph),
      targetConventions: [
        {
          target: 'backend',
          entrypointCount: 2,
          alwaysUsedCount: 1,
          usedExportCount: 0,
        },
      ],
    });
    const arch = parseResult(await handlers.get('get_architecture')!({}));
    expect(arch.isError).toBe(false);
    const data = arch.body.data as { targetConventions?: unknown[]; occurrenceCount?: unknown };
    expect(data.occurrenceCount).toBeDefined();
    expect(Array.isArray(data.targetConventions)).toBe(true);
  });

  it('search_symbols forwards match + filter options without post-limit kind filter', async () => {
    let captured: unknown;
    const graph = fakePort({
      searchSymbols: (q, opts) => {
        captured = { q, opts };
        return Promise.resolve(ok(wrap(searchDto())));
      },
    });
    const { handlers, server } = captureServer();
    registerSearchSymbols(server, deps(graph));
    const result = await handlers.get('search_symbols')!({
      query: 'saveBaseline',
      match: 'exact',
      kinds: ['method'],
      sourceScope: 'production',
      generated: 'exclude',
      limit: 10,
    });
    expect(parseResult(result).isError).toBe(false);
    expect(captured).toMatchObject({
      q: 'saveBaseline',
      opts: {
        match: 'exact',
        limit: 10,
        filter: {
          kinds: ['method'],
          sourceScope: 'production',
          generated: 'exclude',
        },
      },
    });
  });

  it('forwards dead-code and architecture filters, paging, and grouping', async () => {
    const captured: Record<string, unknown> = {};
    const graph = fakePort({
      deadCode: (query) => {
        captured.dead = query;
        return Promise.resolve(
          ok(
            wrap({
              detail: 'summary',
              rows: [],
              totalOrphans: 0,
              reasonCounts: [],
              ruleCounts: [],
            } satisfies DeadCodeResultDto),
          ),
        );
      },
      architectureSummary: (query) => {
        captured.architecture = query;
        return fakePort().architectureSummary(query);
      },
    });
    const { handlers, server } = captureServer();
    registerFindDeadCode(server, deps(graph));
    registerGetArchitecture(server, deps(graph));
    const args = {
      packages: ['pkg'],
      filePath: 'src/a.ts',
      filePrefix: 'src',
      sourceScope: 'test',
      generated: 'only',
      limit: 7,
      cursor: 'cursor',
      groupBy: 'file',
    } as const;
    await handlers.get('find_dead_code')!({
      ...args,
      kinds: ['method'],
      visibilities: ['private'],
    });
    await handlers.get('get_architecture')!(args);
    expect(captured.dead).toMatchObject({
      limit: 7,
      cursor: 'cursor',
      groupBy: 'file',
      filter: {
        packages: ['pkg'],
        filePath: 'src/a.ts',
        filePrefix: 'src',
        kinds: ['method'],
        visibilities: ['private'],
        sourceScope: 'test',
        generated: 'only',
      },
    });
    expect(captured.architecture).toMatchObject({
      limit: 7,
      cursor: 'cursor',
      groupBy: 'file',
      filter: {
        packages: ['pkg'],
        filePath: 'src/a.ts',
        filePrefix: 'src',
        sourceScope: 'test',
        generated: 'only',
      },
    });
  });

  it('routes all package tools with full shared filters and bounded page fields', async () => {
    const captured: Record<string, unknown> = {};
    const graph = fakePort({
      packageDependencies: (query) => {
        captured.dependencies = query;
        return Promise.resolve(ok(wrap({ edgeKind: 'combined', calls: [], imports: [] })));
      },
      whyDepends: (query) => {
        captured.why = query;
        return Promise.resolve(
          ok(
            wrap({
              edgeKind: 'combined',
              calls: [],
              imports: [],
              totalMatchingEvidence: 0,
            }),
          ),
        );
      },
      packageCycles: (query) => {
        captured.cycles = query;
        return Promise.resolve(ok(wrap({ edgeKind: 'combined', components: [] })));
      },
    });
    const { handlers, server } = captureServer();
    registerPackageDependencies(server, deps(graph));
    registerWhyDepends(server, deps(graph));
    registerPackageCycles(server, deps(graph));
    const shared = {
      edgeKind: 'combined',
      packages: ['pkg-a'],
      filePath: 'src/a.ts',
      filePrefix: 'src',
      kinds: ['method'],
      visibilities: ['private'],
      sourceScope: 'production',
      generated: 'exclude',
      limit: 9,
      cursor: 'cursor',
      groupBy: 'package',
    } as const;
    await handlers.get('package_dependencies')!({
      ...shared,
      package: 'pkg-a',
      direction: 'both',
    });
    await handlers.get('why_depends')!({
      ...shared,
      fromPackage: 'pkg-a',
      toPackage: 'pkg-b',
    });
    await handlers.get('package_cycles')!(shared);
    expect(captured.dependencies).toMatchObject({
      edgeKind: 'combined',
      package: 'pkg-a',
      direction: 'both',
      limit: 9,
      cursor: 'cursor',
      groupBy: 'package',
      sampleLimit: 0,
      filter: expect.objectContaining({ filePath: 'src/a.ts', kinds: ['method'] }),
    });
    expect(captured.why).toMatchObject({
      fromPackage: 'pkg-a',
      toPackage: 'pkg-b',
      groupBy: 'package',
      filter: expect.objectContaining({ visibilities: ['private'] }),
    });
    // groupBy implies evidence: an omitted evidenceLimit must be FORWARDED
    // omitted (library default), never the aggregates-only 0 — grouping over
    // zero rows silently reported itself complete.
    expect(captured.why).not.toHaveProperty('evidenceLimit');
    expect(captured.cycles).toMatchObject({
      edgeKind: 'combined',
      groupBy: 'package',
      proofLimit: 0,
      filter: expect.objectContaining({ packages: ['pkg-a'] }),
    });
  });

  it('defaults why_depends to combined call and import evidence', async () => {
    let captured: unknown;
    const graph = fakePort({
      whyDepends: (query) => {
        captured = query;
        return Promise.resolve(
          ok(
            wrap({
              edgeKind: query.edgeKind ?? 'combined',
              calls: [],
              imports: [],
              totalMatchingEvidence: 0,
            }),
          ),
        );
      },
    });
    const { configs, handlers, server } = captureServer();
    registerWhyDepends(server, deps(graph));
    const config = configs.get('why_depends') as {
      inputSchema: { parse: (value: unknown) => unknown };
    };
    const args = config.inputSchema.parse({
      fromPackage: 'pkg-a',
      toPackage: 'pkg-b',
    });

    await handlers.get('why_depends')!(args);

    expect(captured).toMatchObject({ edgeKind: 'combined' });
    // Without groupBy, the documented aggregates-only default holds.
    expect(captured).toMatchObject({ evidenceLimit: 0 });
  });

  it('floors an explicit evidenceLimit 0 at 1 when why_depends grouping is requested', async () => {
    let captured: unknown;
    const graph = fakePort({
      whyDepends: (query) => {
        captured = query;
        return Promise.resolve(
          ok(
            wrap({
              edgeKind: 'combined',
              calls: [],
              imports: [],
              totalMatchingEvidence: 0,
            }),
          ),
        );
      },
    });
    const { handlers, server } = captureServer();
    registerWhyDepends(server, deps(graph));

    await handlers.get('why_depends')!({
      fromPackage: 'pkg-a',
      toPackage: 'pkg-b',
      groupBy: 'package',
      evidenceLimit: 0,
    });

    // Explicit 0 + groupBy is contradictory — grouping needs at least one
    // evidence row per group key to exist at all.
    expect(captured).toMatchObject({ groupBy: 'package', evidenceLimit: 1 });
  });

  it('maps port errors through errorResult', async () => {
    const graph = fakePort({
      searchSymbols: (): Promise<Result<GraphToolResult<SymbolSearchDto>, McpReadError>> =>
        Promise.resolve(err({ code: 'boom', message: 'failed' })),
    });
    const { handlers, server } = captureServer();
    registerSearchSymbols(server, deps(graph));
    const result = await handlers.get('search_symbols')!({ query: 'x' });
    const parsed = parseResult(result);
    expect(parsed.isError).toBe(true);
    expect((parsed.body.error as { code: string }).code).toBe('boom');
  });

  it('get_runtime_wiring forwards bounded filters/page/grouping to its injected port', async () => {
    let captured: unknown;
    const runtimeWiring: RuntimeWiringReadPort = {
      query: (input) => {
        captured = input;
        return Promise.resolve(
          ok({
            context: {
              project: {
                root: '/fixture',
                scope: 'project' as const,
                configPath: 'opensip-cli.config.yml',
              },
              runtime: {
                kind: 'runtime-wiring' as const,
                identity: `w1:${'a'.repeat(64)}`,
                capturedAt: '2026-01-01T00:00:00.000Z',
              },
              projectKey: 'abcdabcdabcdabcd',
              snapshotKey: `w1:${'a'.repeat(64)}`,
            },
            nodes: [
              { id: 'command:alpha inspect', kind: 'command', label: 'inspect', tool: 'alpha' },
            ],
            edges: [
              {
                from: 'command:alpha inspect',
                to: 'handler:alpha inspect',
                kind: 'command-dispatches-handler',
                source: 'command-spec',
                confidence: 'medium',
                staticBridge: 'unresolved',
              },
            ],
            page: { limit: 10, hasMore: false, edgeTruncated: false },
            groups: [{ key: 'alpha', count: 1 }],
            groupTruncated: false,
            coverage: {
              complete: true,
              scope: 'captured-admitted-registry-and-command-inventory',
              truncated: false,
              reasons: [],
            },
            effectiveFilters: {
              tool: 'alpha',
              command: 'inspect',
              provenanceSource: 'bundled',
              limit: 10,
              groupBy: 'tool',
              detail: 'nodes',
            },
          }),
        );
      },
    };
    const { handlers, server } = captureServer();
    registerGetRuntimeWiring(server, { ...deps(fakePort()), runtimeWiring });
    const result = await handlers.get('get_runtime_wiring')!({
      tool: 'alpha',
      command: 'inspect',
      provenanceSource: 'bundled',
      limit: 10,
      cursor: undefined,
      groupBy: 'tool',
      detail: 'nodes',
    });
    expect(parseResult(result)).toMatchObject({
      isError: false,
      body: {
        edges: [
          {
            source: 'command-spec',
            confidence: 'medium',
            staticBridge: 'unresolved',
          },
        ],
        groups: [{ key: 'alpha', count: 1 }],
      },
    });
    expect(captured).toEqual({
      tool: 'alpha',
      command: 'inspect',
      provenanceSource: 'bundled',
      limit: 10,
      cursor: undefined,
      groupBy: 'tool',
      detail: 'nodes',
    });
  });

  it('get_runtime_wiring maps its injected port error', async () => {
    const runtimeWiring: RuntimeWiringReadPort = {
      query: () => Promise.resolve(err({ code: 'runtime-wiring-failed', message: 'failed' })),
    };
    const { handlers, server } = captureServer();
    registerGetRuntimeWiring(server, { ...deps(fakePort()), runtimeWiring });
    const parsed = parseResult(await handlers.get('get_runtime_wiring')!({}));
    expect(parsed.isError).toBe(true);
    expect(parsed.body.error).toMatchObject({ code: 'runtime-wiring-failed' });
  });
});
