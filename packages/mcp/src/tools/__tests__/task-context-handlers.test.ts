import { err, ok } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { registerGetContextStatus } from '../get-context-status.js';
import { registerGetFileContext } from '../get-file-context.js';
import { registerGetSymbol } from '../get-symbol.js';
import { registerImpactFiles } from '../impact-files.js';
import { registerSelectTests } from '../select-tests.js';

import type { GraphReadPort, ImpactFilesDto } from '../../graph-read-port.js';
import type { CallToolResult, McpStdioServer } from '../../server.js';
import type { GraphToolResult, SymbolRef } from '../../symbol-dto.js';
import type { McpToolDeps } from '../types.js';
import type { ProjectInventorySnapshot, TestSelectionSnapshot } from '@opensip-cli/contracts';
import type { GraphEntityDetail } from '@opensip-cli/graph/read';
import type { z } from 'zod';

type Handler = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

function capture() {
  const handlers = new Map<string, Handler>();
  const schemas = new Map<string, z.ZodObject>();
  const server = {
    register: (name: string, config: { readonly inputSchema: z.ZodObject }, handler: Handler) => {
      handlers.set(name, handler);
      schemas.set(name, config.inputSchema);
    },
  } as unknown as McpStdioServer;
  return { handlers, schemas, server };
}

function body(result: CallToolResult): Record<string, unknown> {
  const content = result.content[0];
  return JSON.parse(content?.type === 'text' ? content.text : '{}') as Record<string, unknown>;
}

const COVERAGE = {
  inventory: { requested: true, complete: true, truncated: false, reasons: [] },
  evidence: { requested: false, complete: true, truncated: false, reasons: [] },
  grouping: { requested: false, complete: true, truncated: false, reasons: [] },
  projection: {
    requested: false,
    complete: true,
    truncated: false,
    reasons: [],
  },
  complete: true,
  truncated: false,
  reasons: [],
} as const;

function envelope<T>(data: T): GraphToolResult<T> {
  return {
    data,
    context: {
      project: {
        root: '/project',
        scope: 'project' as const,
        configPath: 'opensip-cli.config.yml',
      },
      catalog: { status: 'loaded' as const, identity: 'g1:current' },
    },
    freshness: {
      fresh: true,
      verifiedAt: '2026-07-13T00:00:00.000Z',
      verification: 'complete' as const,
    },
    coverage: COVERAGE,
  };
}

const IMPACT: ImpactFilesDto = {
  changedFunctions: [
    {
      qualifiedName: 'a',
      filePath: 'src/a.ts',
      line: 1,
      package: 'pkg',
      reason: 'changed',
    },
  ],
  impactedFunctions: [],
  impactedPackages: [{ name: 'pkg', functionCount: 1 }],
  impactedFiles: ['src/a.ts'],
  requestedFiles: ['src/a.ts'],
  matchedFiles: ['src/a.ts'],
  unmatchedFiles: [],
  trust: {
    coverage: 'full',
    fallback: 'targeted',
    fullyVerified: true,
    uncertainties: [],
  },
  truncated: false,
  coverage: COVERAGE,
  nextActions: [],
};

const INVENTORY: ProjectInventorySnapshot = {
  schemaVersion: 1,
  snapshotId: 'i1:inventory',
  metadataIdentity: 'm1:inventory',
  project: {
    configIdentity: 'sha256:config',
    workspacePatterns: [],
    languages: [],
    fileCount: 0,
    packageCount: 0,
  },
  packages: [],
  files: [],
  coverage: { status: 'complete', reasonCodes: [], observed: 0, total: 0 },
};

function deps(input: {
  readonly graph?: Partial<McpToolDeps['graph']>;
  readonly codebase?: Partial<McpToolDeps['codebase']>;
  readonly context?: Partial<McpToolDeps['context']>;
}): McpToolDeps {
  return {
    graph: input.graph as McpToolDeps['graph'],
    codebase: input.codebase as McpToolDeps['codebase'],
    context: input.context as McpToolDeps['context'],
    results: {} as McpToolDeps['results'],
    runtimeWiring: {} as McpToolDeps['runtimeWiring'],
    validToolIds: new Set(),
  };
}

describe('task-context MCP handlers', () => {
  it('normalizes explicit files and threads cancellation to impact_files', async () => {
    const impactFiles = vi.fn<GraphReadPort['impactFiles']>(() =>
      Promise.resolve(ok(envelope(IMPACT))),
    );
    const { handlers, schemas, server } = capture();
    registerImpactFiles(server, deps({ graph: { impactFiles } }));
    const parsed = schemas.get('impact_files')!.parse({ files: ['src\\a.ts'], depth: 2, top: 10 });
    const signal = new AbortController().signal;
    const result = await handlers.get('impact_files')!(parsed, { signal });
    expect(impactFiles).toHaveBeenCalledWith(['src/a.ts'], { maxDepth: 2, top: 10 }, signal);
    expect(body(result)).toMatchObject({
      data: { requestedFiles: ['src/a.ts'] },
    });
  });

  it('resolves a unique entity inside one graph-port generation capture', async () => {
    const symbol = {
      symbolId: 'src/a.ts:1:0',
      bodyHash: 'hash',
      simpleName: 'a',
      qualifiedName: 'a',
      filePath: 'src/a.ts',
      line: 1,
      column: 0,
      kind: 'function-declaration',
      visibility: 'exported',
      package: 'pkg',
      inTestFile: false,
      definedInGenerated: false,
    } as const satisfies SymbolRef;
    const detail: GraphEntityDetail = {
      symbol,
      endLine: 2,
      parameters: [],
      returnType: null,
      enclosingClass: null,
      decorators: [],
      testReachability: {},
      coverage: COVERAGE,
    };
    const symbolAtLocation = vi.fn<GraphReadPort['symbolAtLocation']>(() =>
      Promise.resolve(ok(envelope({ candidates: [symbol], entity: detail }))),
    );
    const { handlers, server } = capture();
    registerGetSymbol(server, deps({ graph: { symbolAtLocation } }));
    const signal = new AbortController().signal;
    const result = await handlers.get('get_symbol')!(
      { file: 'src/a.ts', line: 1, detail: 'entity' },
      { signal },
    );
    expect(symbolAtLocation).toHaveBeenCalledWith('src/a.ts', 1, 'entity', signal);
    expect(body(result)).toMatchObject({
      data: { endLine: 2, symbol: { symbolId: symbol.symbolId } },
    });
  });

  it('preserves excluded file context and threads the request signal', async () => {
    const fileContext = vi.fn(() =>
      Promise.resolve(
        ok({
          status: 'excluded' as const,
          inventoryIdentity: INVENTORY.snapshotId,
          project: INVENTORY.project,
          coverage: INVENTORY.coverage,
          freshness: {
            fresh: true,
            capturedAt: '2026-07-13T00:00:00.000Z',
            verification: 'complete' as const,
            reasonCodes: [],
          },
          reasonCodes: ['file-excluded'],
          nextActions: ['Review exclusions.'],
        }),
      ),
    );
    const { handlers, server } = capture();
    registerGetFileContext(server, deps({ codebase: { fileContext } }));
    const signal = new AbortController().signal;
    const result = await handlers.get('get_file_context')!({ file: 'src/a.ts' }, { signal });
    expect(fileContext).toHaveBeenCalledWith('src/a.ts', signal);
    expect(body(result)).toMatchObject({
      status: 'excluded',
      reasonCodes: ['file-excluded'],
    });
  });

  it('joins one captured inventory with one graph test-selection read', async () => {
    const inventoryStatus = vi.fn(() =>
      Promise.resolve(
        ok({
          snapshot: INVENTORY,
          identity: INVENTORY.snapshotId,
          coverage: INVENTORY.coverage,
          freshness: {
            fresh: true,
            capturedAt: '2026-07-13T00:00:00.000Z',
            verification: 'complete' as const,
            reasonCodes: [],
          },
          nextActions: [],
        }),
      ),
    );
    const selection: TestSelectionSnapshot = {
      schemaVersion: 1,
      snapshotId: 'ts1:selection',
      files: ['src/a.ts'],
      tests: [],
      commands: [],
      uncoveredFiles: ['src/a.ts'],
      trust: {
        status: 'fallback',
        reasonCodes: ['no-static-test-candidates'],
        fallbackTier: 'full',
      },
      graphIdentity: 'g1:current',
      inventoryIdentity: INVENTORY.snapshotId,
    };
    const selectTests = vi.fn<GraphReadPort['selectTests']>(() =>
      Promise.resolve(ok(envelope(selection))),
    );
    const { handlers, server } = capture();
    registerSelectTests(server, deps({ graph: { selectTests }, codebase: { inventoryStatus } }));
    const signal = new AbortController().signal;
    const result = await handlers.get('select_tests')!(
      {
        files: ['src/a.ts'],
        tier: 'package',
        depth: 3,
        proofDetail: 'paths',
        limit: 50,
        commandLimit: 10,
        proofLimit: 4,
      },
      { signal },
    );
    expect(inventoryStatus).toHaveBeenCalledWith(signal);
    expect(selectTests).toHaveBeenCalledWith(
      ['src/a.ts'],
      INVENTORY,
      {
        tier: 'package',
        maxDepth: 3,
        proofDetail: 'paths',
        limit: 50,
        commandLimit: 10,
        proofLimit: 4,
      },
      signal,
    );
    expect(body(result)).toMatchObject({
      data: { inventoryIdentity: INVENTORY.snapshotId },
    });
  });

  it('passes an optional exact Run reference to get_context_status', async () => {
    const contextStatus = vi.fn(() =>
      Promise.resolve(
        ok({
          status: 'missing' as const,
          fileScope: { status: 'mismatched' as const },
          steps: [],
          pointers: [],
          reasonCodes: ['context-run-missing'],
          nextActions: ['Run the suite.'],
        }),
      ),
    );
    const { handlers, schemas, server } = capture();
    registerGetContextStatus(server, deps({ context: { contextStatus } }));
    const signal = new AbortController().signal;
    const parsed = schemas
      .get('get_context_status')!
      .parse({ runId: 'run-1', files: ['src\\a.ts'] });
    const result = await handlers.get('get_context_status')!(parsed, {
      signal,
    });
    expect(contextStatus).toHaveBeenCalledWith({ runId: 'run-1', files: ['src/a.ts'] }, signal);
    expect(body(result)).toMatchObject({
      status: 'missing',
      fileScope: { status: 'mismatched' },
      nextActions: ['Run the suite.'],
    });
  });

  it('omits options for get_context_status when neither runId nor files are set', async () => {
    const contextStatus = vi.fn(() =>
      Promise.resolve(
        ok({
          status: 'available' as const,
          fileScope: { status: 'matched' as const },
          steps: [],
          pointers: [],
          reasonCodes: [],
          nextActions: [],
        }),
      ),
    );
    const { handlers, server } = capture();
    registerGetContextStatus(server, deps({ context: { contextStatus } }));
    const result = await handlers.get('get_context_status')!({});
    expect(contextStatus).toHaveBeenCalledWith(undefined, undefined);
    expect(body(result)).toMatchObject({ status: 'available' });
  });

  it('threads only files when runId is omitted from get_context_status', async () => {
    const contextStatus = vi.fn(() =>
      Promise.resolve(
        ok({
          status: 'available' as const,
          fileScope: { status: 'matched' as const },
          steps: [],
          pointers: [],
          reasonCodes: ['stale'],
          nextActions: [],
        }),
      ),
    );
    const { handlers, server } = capture();
    registerGetContextStatus(server, deps({ context: { contextStatus } }));
    await handlers.get('get_context_status')!({ files: ['src/a.ts'] });
    expect(contextStatus).toHaveBeenCalledWith({ files: ['src/a.ts'] }, undefined);
  });

  it('surfaces inventory and graph failures from select_tests', async () => {
    {
      const inventoryStatus = vi.fn(() =>
        Promise.resolve(err({ code: 'cancelled', message: 'stopped' })),
      );
      const selectTests = vi.fn();
      const { handlers, server } = capture();
      registerSelectTests(server, deps({ graph: { selectTests }, codebase: { inventoryStatus } }));
      const result = await handlers.get('select_tests')!({
        files: ['src/a.ts'],
        tier: 'package',
        depth: 1,
        proofDetail: 'counts',
        limit: 10,
        commandLimit: 5,
        proofLimit: 2,
      });
      expect(result.isError).toBe(true);
      expect(selectTests).not.toHaveBeenCalled();
    }
    {
      const inventoryStatus = vi.fn(() =>
        Promise.resolve(
          ok({
            snapshot: INVENTORY,
            identity: INVENTORY.snapshotId,
            coverage: INVENTORY.coverage,
            freshness: {
              fresh: true,
              capturedAt: '2026-07-13T00:00:00.000Z',
              verification: 'complete' as const,
              reasonCodes: [],
            },
            nextActions: [],
          }),
        ),
      );
      const selectTests = vi.fn(() =>
        Promise.resolve(err({ code: 'test-selection-failed', message: 'nope' })),
      );
      const { handlers, server } = capture();
      registerSelectTests(server, deps({ graph: { selectTests }, codebase: { inventoryStatus } }));
      const result = await handlers.get('select_tests')!({
        files: ['src/a.ts'],
        tier: 'package',
        depth: 1,
        proofDetail: 'counts',
        limit: 10,
        commandLimit: 5,
        proofLimit: 2,
      });
      expect(result.isError).toBe(true);
    }
  });

  it('omits top from impact_files when unset and surfaces graph errors', async () => {
    const impactFiles = vi.fn<GraphReadPort['impactFiles']>(() =>
      Promise.resolve(ok(envelope(IMPACT))),
    );
    const { handlers, server } = capture();
    registerImpactFiles(server, deps({ graph: { impactFiles } }));
    await handlers.get('impact_files')!({ files: ['src/a.ts'], depth: 1 });
    expect(impactFiles).toHaveBeenCalledWith(['src/a.ts'], { maxDepth: 1 }, undefined);

    const failing = vi.fn<GraphReadPort['impactFiles']>(() =>
      Promise.resolve(err({ code: 'impact-read-failed', message: 'boom' })),
    );
    const second = capture();
    registerImpactFiles(second.server, deps({ graph: { impactFiles: failing } }));
    const result = await second.handlers.get('impact_files')!({ files: ['src/a.ts'], depth: 1 });
    expect(result.isError).toBe(true);
  });

  it('surfaces get_file_context port errors', async () => {
    const fileContext = vi.fn(() =>
      Promise.resolve(err({ code: 'invalid-input', message: 'bad path' })),
    );
    const { handlers, server } = capture();
    registerGetFileContext(server, deps({ codebase: { fileContext } }));
    const result = await handlers.get('get_file_context')!({ file: '../escape.ts' });
    expect(result.isError).toBe(true);
  });

  it('surfaces get_context_status port errors', async () => {
    const contextStatus = vi.fn(() =>
      Promise.resolve(err({ code: 'context-read-failed', message: 'unavailable' })),
    );
    const { handlers, server } = capture();
    registerGetContextStatus(server, deps({ context: { contextStatus } }));
    const result = await handlers.get('get_context_status')!({ runId: 'run-x' });
    expect(result.isError).toBe(true);
    expect(contextStatus).toHaveBeenCalledWith({ runId: 'run-x' }, undefined);
  });
});
