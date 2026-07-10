/**
 * Graph tool handlers vs. a FAKE async `GraphReadPort` (Phase 1 cutover).
 */

import { err, ok, type Result } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { registerBlastRadius } from '../blast-radius.js';
import { registerCalleesOf } from '../callees-of.js';
import { registerFindDeadCode } from '../find-dead-code.js';
import { registerGetArchitecture } from '../get-architecture.js';
import { registerGetSymbol } from '../get-symbol.js';
import { registerSearchSymbols } from '../search-symbols.js';
import { registerTracePath } from '../trace-path.js';
import { registerWhoCalls } from '../who-calls.js';

import type {
  ArchitectureSummaryDto,
  BlastDto,
  DeadCodeDto,
  GraphReadPort,
  RefreshResult,
  TraversalSnapshot,
} from '../../graph-read-port.js';
import type { McpReadError } from '../../mcp-error.js';
import type { CallToolResult, McpStdioServer } from '../../server.js';
import type {
  Freshness,
  GraphEvidenceContext,
  GraphToolResult,
  SymbolRef,
} from '../../symbol-dto.js';
import type { McpToolDeps } from '../types.js';

type Handler = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

function captureServer(): { handlers: Map<string, Handler>; server: McpStdioServer } {
  const handlers = new Map<string, Handler>();
  const server = {
    register: (name: string, _config: unknown, cb: Handler) => {
      handlers.set(name, cb);
    },
  } as unknown as McpStdioServer;
  return { handlers, server };
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

const COVERAGE = { complete: true, truncated: false, reasons: [] as const };

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

function fakePort(overrides: Partial<GraphReadPort> = {}): GraphReadPort {
  const base: GraphReadPort = {
    catalogStatus: () => Promise.resolve(ok({ context: CONTEXT, freshness: FRESH })),
    resolveSymbolId: (id) =>
      Promise.resolve(ok(wrap(id === 'src/a.ts:10:2' ? symRef() : undefined))),
    searchSymbols: () => Promise.resolve(ok(wrap([symRef()] as readonly SymbolRef[]))),
    findBySpan: () => Promise.resolve(ok(wrap([symRef()] as readonly SymbolRef[]))),
    traverse: (query) => {
      const nodes = [
        { symbol: symRef(), depth: 0 },
        { symbol: symRef({ symbolId: 'src/b.ts:1:0' }), depth: 1 },
      ];
      const data: TraversalSnapshot = {
        found: true,
        nodes,
        path: query.direction === 'path' ? nodes.map((n) => n.symbol) : undefined,
        truncated: false,
        identityMode: 'body-twin-union',
      };
      return Promise.resolve(ok(wrap(data)));
    },
    blast: () =>
      Promise.resolve(
        ok(
          wrap({
            symbol: symRef(),
            direct: 2,
            transitive: 4,
            score: 4,
            identityMode: 'body-twin-union',
          } satisfies BlastDto),
        ),
      ),
    deadCode: () =>
      Promise.resolve(
        ok(wrap([{ symbol: symRef(), message: 'orphan' }] as readonly DeadCodeDto[])),
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
              edgeKind: 'call',
              catalogResolutionMode: 'exact',
            },
            packageCount: 1,
            packageEdges: [
              {
                fromPackage: 'pkg',
                toPackage: 'other',
                kind: 'call',
                count: 1,
                countUnit: 'call-sites',
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
    whyDepends: () => Promise.resolve(ok(wrap({ edgeKind: 'combined', calls: [], imports: [] }))),
    packageCycles: () => Promise.resolve(ok(wrap({ edgeKind: 'call', components: [] }))),
  };
  return { ...base, ...overrides };
}

function deps(graph: GraphReadPort): McpToolDeps {
  return {
    graph,
    results: {} as McpToolDeps['results'],
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
    });
    expect(Array.isArray(parsed.body.data)).toBe(true);
  });

  it('get_symbol returns candidates with context', async () => {
    const { handlers, server } = captureServer();
    registerGetSymbol(server, deps(fakePort()));
    const result = await handlers.get('get_symbol')!({ file: 'src/a.ts', line: 10 });
    const parsed = parseResult(result);
    expect(parsed.isError).toBe(false);
    expect(parsed.body.context).toEqual(CONTEXT);
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
        return Promise.resolve(ok(wrap([symRef()] as readonly SymbolRef[])));
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

  it('maps port errors through errorResult', async () => {
    const graph = fakePort({
      searchSymbols: (): Promise<Result<GraphToolResult<readonly SymbolRef[]>, McpReadError>> =>
        Promise.resolve(err({ code: 'boom', message: 'failed' })),
    });
    const { handlers, server } = captureServer();
    registerSearchSymbols(server, deps(graph));
    const result = await handlers.get('search_symbols')!({ query: 'x' });
    const parsed = parseResult(result);
    expect(parsed.isError).toBe(true);
    expect((parsed.body.error as { code: string }).code).toBe('boom');
  });
});
