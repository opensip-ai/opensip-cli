import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigurationError, logger, SystemError } from '@opensip-cli/core';
import { DataStoreFactory } from '@opensip-cli/datastore';
import { SessionRepo } from '@opensip-cli/session-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CatalogRepo } from '../../persistence/catalog-repo.js';
import * as catalogFreshness from '../../read/catalog-freshness.js';
import { graphImpactCommandSpec } from '../graph/graph-aux-command-specs.js';
import { buildImpactSessionContribution, executeImpact } from '../impact.js';
import * as orchestrate from '../orchestrate.js';

import type { Catalog } from '../../types.js';
import type { ImpactUncertainty, SignalEnvelope, StoredSession } from '@opensip-cli/contracts';
import type { ToolCliContext, ToolRunCompletion } from '@opensip-cli/core';
import type { DataStore } from '@opensip-cli/datastore';

const COMPLETE_BUILD_COVERAGE = {
  status: 'complete' as const,
  discoveredFiles: 2,
  parseErrorFiles: 0,
  filesIdentity: `sha256:${'a'.repeat(64)}`,
};

function makeCatalog(over: Partial<Catalog> = {}): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-05-22T00:00:00.000Z',
    cacheKey: 'ts-test',
    filesFingerprint: '0\n',
    buildCoverage: COMPLETE_BUILD_COVERAGE,
    functions: {
      callee: [
        {
          bodyHash: 'callee',
          simpleName: 'callee',
          qualifiedName: 'callee',
          filePath: 'src/callee.ts',
          line: 1,
          column: 0,
          endLine: 5,
          kind: 'function-declaration',
          params: [],
          returnType: null,
          enclosingClass: null,
          decorators: [],
          visibility: 'exported',
          inTestFile: false,
          definedInGenerated: false,
          calls: [],
        },
      ],
      caller: [
        {
          bodyHash: 'caller',
          simpleName: 'caller',
          qualifiedName: 'caller',
          filePath: 'src/caller.ts',
          line: 1,
          column: 0,
          endLine: 8,
          kind: 'function-declaration',
          params: [],
          returnType: null,
          enclosingClass: null,
          decorators: [],
          visibility: 'exported',
          inTestFile: false,
          definedInGenerated: false,
          calls: [
            {
              to: ['callee'],
              line: 2,
              column: 4,
              resolution: 'static',
              confidence: 'high',
              text: 'callee()',
            },
          ],
        },
      ],
    },
    ...over,
  };
}

function mockCli(datastore?: DataStore): ToolCliContext {
  return {
    setExitCode: vi.fn(),
    emitJson: vi.fn(),
    emitRaw: vi.fn(),
    deliverSignals: vi.fn().mockResolvedValue({ cloudAccepted: 0 }),
    render: vi.fn().mockResolvedValue(undefined),
    scope: {
      datastore: () => datastore,
      languages: { list: () => [] },
      graph: {
        adapters: {
          size: 0,
          getAll: () => [],
          getById: () => undefined,
        },
      },
    },
  } as unknown as ToolCliContext;
}

describe('executeImpact', () => {
  let verifySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Unit tests inject in-memory catalogs; stub freshness so reuse is gated
    // only by buildCoverage + this controlled verification result.
    verifySpy = vi.spyOn(catalogFreshness, 'verifyCatalogInputs').mockResolvedValue({
      ok: true,
      value: {
        fresh: true,
        verifiedAt: '2026-05-22T00:00:00.000Z',
        verification: 'complete',
      },
    });
  });

  afterEach(() => {
    verifySpy.mockRestore();
  });

  it('--files works without git and returns graph-impact result', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    const result = await executeImpact(
      {
        cwd: '/proj',
        json: true,
        files: ['src/callee.ts'],
      },
      cli,
    );
    expect(result.type).toBe('graph-impact');
    expect(result.changedFiles).toContain('src/callee.ts');
    expect(result.changedFunctions.some((f) => f.qualifiedName === 'callee')).toBe(true);
    expect(result.impactedFiles).toEqual(['src/callee.ts', 'src/caller.ts']);
    expect(result.trust).toMatchObject({
      coverage: 'full',
      fallback: 'targeted',
      fullyVerified: true,
    });
    expect(result.recommendedCommands.length).toBeGreaterThan(0);
    expect(result.catalog).toEqual({
      builtAt: '2026-05-22T00:00:00.000Z',
      language: 'typescript',
      filesFingerprint: '9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa',
      cacheKeyDigest: 'f00a99cf844c0aaf94b027bf6f838176b6ada87ae8f9d5e23ee824c04aa36880',
    });
    expect(cli.emitJson).toHaveBeenCalledWith(result);
    const delivered = (
      cli.deliverSignals as unknown as {
        mock: { calls: [[SignalEnvelope, unknown]] };
      }
    ).mock.calls[0]?.[0];
    expect(delivered?.tool).toBe('graph');
    expect(delivered?.signals).toHaveLength(1);
    expect(delivered?.signals[0]?.ruleId).toBe('graph.impact.blast-radius');
    expect(delivered?.signals[0]?.metadata.blastRadius).toMatchObject({
      dependents: 1,
      impactedFiles: 1,
      confidence: 'high',
    });
    expect(delivered?.signals[0]?.metadata).toMatchObject({
      impactedFiles: ['src/callee.ts', 'src/caller.ts'],
      trust: result.trust,
    });
    expect(delivered?.verdict).toMatchObject({
      passed: true,
      summary: { errors: 0, warnings: 1 },
    });
    expect(delivered?.verification).toEqual(result.trust);
    datastore.close();
  });

  it('--json --raw emits the raw graph-impact payload', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    const result = await executeImpact(
      {
        cwd: '/proj',
        json: true,
        raw: true,
        files: ['src/callee.ts'],
      },
      cli,
    );
    expect(cli.emitRaw).toHaveBeenCalledWith(result);
    expect(cli.emitJson).not.toHaveBeenCalled();
    datastore.close();
  });

  it('downgrades signal blast confidence when impact trust is unknown', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const source = makeCatalog();
    new CatalogRepo(datastore).replaceAll({
      version: source.version,
      tool: source.tool,
      language: source.language,
      builtAt: source.builtAt,
      cacheKey: source.cacheKey,
      buildCoverage: source.buildCoverage,
      functions: source.functions,
    });
    const cli = mockCli(datastore);
    const result = await executeImpact(
      {
        cwd: '/proj',
        json: true,
        files: ['src/callee.ts'],
      },
      cli,
    );
    expect(result.trust.coverage).toBe('unknown');
    const delivered = (
      cli.deliverSignals as unknown as {
        mock: { calls: [[SignalEnvelope, unknown]] };
      }
    ).mock.calls[0]?.[0];
    expect(delivered?.signals[0]?.metadata.blastRadius).toMatchObject({
      confidence: 'low',
    });
    datastore.close();
  });

  it('rebuilds when the cached catalog fails freshness verification', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const stale = makeCatalog({ cacheKey: 'stale-key' });
    const fresh = makeCatalog({ cacheKey: 'fresh-key' });
    new CatalogRepo(datastore).replaceAll(stale);
    verifySpy.mockResolvedValue({
      ok: true,
      value: {
        fresh: false,
        verifiedAt: '2026-05-22T00:00:00.000Z',
        verification: 'complete',
        reasonCode: 'cache-key-changed',
        reason: 'Catalog cache inputs changed',
      },
    });
    const runGraph = vi.spyOn(orchestrate, 'runGraph').mockImplementation(() => {
      new CatalogRepo(datastore).replaceAll(fresh);
      return Promise.resolve({
        catalog: fresh,
        indexes: null,
        signals: [],
        resolutionStats: null,
        cacheHit: false,
        features: null,
      });
    });
    try {
      const result = await executeImpact(
        { cwd: '/proj', json: true, files: ['src/callee.ts'] },
        mockCli(datastore),
      );
      expect(runGraph).toHaveBeenCalledOnce();
      expect(result.catalog?.cacheKeyDigest).toBe(
        createHash('sha256').update('fresh-key', 'utf8').digest('hex'),
      );
    } finally {
      runGraph.mockRestore();
      datastore.close();
    }
  });

  it('rebuilds when build coverage is incomplete even if verification is fresh', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    const incomplete = makeCatalog({
      buildCoverage: {
        status: 'partial',
        discoveredFiles: 2,
        parseErrorFiles: 1,
        filesIdentity: `sha256:${'b'.repeat(64)}`,
      },
    });
    const rebuilt = makeCatalog();
    new CatalogRepo(datastore).replaceAll(incomplete);
    const runGraph = vi.spyOn(orchestrate, 'runGraph').mockImplementation(() => {
      new CatalogRepo(datastore).replaceAll(rebuilt);
      return Promise.resolve({
        catalog: rebuilt,
        indexes: null,
        signals: [],
        resolutionStats: null,
        cacheHit: false,
        features: null,
      });
    });
    try {
      await executeImpact(
        { cwd: '/proj', json: true, files: ['src/callee.ts'] },
        mockCli(datastore),
      );
      expect(runGraph).toHaveBeenCalledOnce();
      // Freshness should not be consulted when build coverage already fails the gate.
      expect(verifySpy).not.toHaveBeenCalled();
    } finally {
      runGraph.mockRestore();
      datastore.close();
    }
  });

  it('renders human impact lines and the truncation hint outside JSON mode', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    const result = await executeImpact(
      {
        cwd: '/proj',
        files: ['src/callee.ts'],
        top: '1',
      },
      cli,
    );
    expect(result.truncated).toBe(true);
    const renderCalls = (cli.render as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const rendered = renderCalls[0]?.[0] as { lines?: readonly string[] } | undefined;
    expect(rendered?.lines?.some((line) => line.includes('truncated'))).toBe(true);
    expect(rendered?.lines?.some((line) => line.includes('Verification coverage'))).toBe(true);
    expect(rendered?.lines?.some((line) => line.includes('Recommended next commands'))).toBe(true);
    datastore.close();
  });

  it('builds a graph session contribution for human-facing impact runs', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const completion = await graphImpactCommandSpec.handler(
      {
        cwd: '/proj',
        files: ['src/callee.ts'],
      },
      cli,
    );
    const session = (completion as ToolRunCompletion | undefined)?.session;

    expect(session).toMatchObject({
      tool: 'graph',
      cwd: '/proj',
      score: 100,
      passed: true,
    });
    expect(session?.recipe).toBeUndefined();
    expect(session?.payload).toMatchObject({
      __version: 1,
      impactStatus: 'available',
      summary: {
        total: 1,
        passed: 1,
        failed: 0,
        errors: 0,
        warnings: 1,
      },
      checks: [
        {
          checkSlug: 'graph.impact.blast-radius',
          passed: true,
          violationCount: 1,
        },
      ],
      impact: {
        changedFiles: ['src/callee.ts'],
        impactedFiles: ['src/callee.ts', 'src/caller.ts'],
        trust: {
          coverage: 'full',
          fallback: 'targeted',
          fullyVerified: true,
          uncertainties: [],
        },
        omitted: {
          changedFiles: 0,
          changedFunctions: 0,
          impactedFunctions: 0,
          impactedFiles: 0,
          impactedPackages: 0,
          recommendedCommands: 0,
        },
      },
    });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'graph.cli.impact.session_projection',
        retainedChangedFiles: 1,
        retainedImpactedFunctions: 1,
        omittedChangedFiles: 0,
        omittedImpactedFunctions: 0,
        trustCoverage: 'full',
        sourceTruncated: false,
      }),
    );
    info.mockRestore();
    datastore.close();
  });

  it('round-trips the enriched opaque payload through the host session repository', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    const completion = await graphImpactCommandSpec.handler(
      { cwd: '/proj', json: true, files: ['src/callee.ts'] },
      cli,
    );
    const contribution = (completion as ToolRunCompletion | undefined)?.session;
    if (!contribution) throw new Error('expected graph impact session contribution');
    const now = '2026-07-12T00:00:00.000Z';
    const stored: StoredSession = {
      id: 'GRAPH_IMPACT_ROUND_TRIP',
      tool: contribution.tool,
      cwd: contribution.cwd,
      startedAt: now,
      completedAt: now,
      durationMs: 0,
      score: contribution.score,
      passed: contribution.passed,
      payload: contribution.payload,
    };
    const repo = new SessionRepo(datastore);
    repo.save(stored);

    expect(repo.get(stored.id)?.payload).toEqual(contribution?.payload);
    expect(repo.get(stored.id)?.payload).toMatchObject({
      __version: 1,
      impactStatus: 'available',
      impact: { changedFiles: ['src/callee.ts'] },
    });
    datastore.close();
  });

  it('builds the same impact session contribution for JSON carrier mode', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    const completion = await graphImpactCommandSpec.handler(
      {
        cwd: '/proj',
        json: true,
        files: ['src/callee.ts'],
      },
      cli,
    );

    expect((completion as ToolRunCompletion | undefined)?.session?.payload).toMatchObject({
      __version: 1,
      impactStatus: 'available',
      impact: {
        changedFiles: ['src/callee.ts'],
        impactedFiles: ['src/callee.ts', 'src/caller.ts'],
      },
    });
    datastore.close();
  });

  it('builds an impact session contribution for raw JSON carrier mode', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    const completion = await graphImpactCommandSpec.handler(
      {
        cwd: '/proj',
        json: true,
        raw: true,
        files: ['src/callee.ts'],
      },
      cli,
    );

    expect(cli.emitRaw).toHaveBeenCalled();
    expect((completion as ToolRunCompletion | undefined)?.session?.payload).toMatchObject({
      impactStatus: 'available',
    });
    datastore.close();
  });

  it('preserves the ordinary session and logs bounded counts when the projection cannot fit', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    const base = await executeImpact({ cwd: '/proj', json: true, files: ['src/callee.ts'] }, cli);
    const uncertainties = Array.from({ length: 3000 }, (_, index): ImpactUncertainty => ({
      code: 'changed-file-unmatched',
      source: 'files',
      message: `${String(index).padStart(4, '0')}:${'x'.repeat(507)}`,
    }));
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const contribution = buildImpactSessionContribution(
      { cwd: '/proj' },
      {
        ...base,
        trust: {
          coverage: 'unknown',
          fallback: 'targeted',
          fullyVerified: false,
          uncertainties,
        },
      },
    );

    expect(contribution.passed).toBe(true);
    expect(contribution.payload).toMatchObject({
      __version: 1,
      impactStatus: 'omitted-overflow',
      summary: { total: 1, warnings: 1 },
    });
    expect((contribution.payload as { impact?: unknown }).impact).toBeUndefined();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: 'graph.cli.impact.session_projection',
        omittedReason: 'projection-overflow',
        trustCoverage: 'unknown',
        sourceTruncated: false,
      }),
    );
    info.mockRestore();
    datastore.close();
  });

  it('never copies a path-bearing raw catalog cache key or file fingerprint into results', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(
      makeCatalog({
        cacheKey: 'missing-config:/private/repo/tsconfig.json',
        filesFingerprint: '1\n/private/repo/src/a.ts|123|4',
      }),
    );
    const cli = mockCli(datastore);
    const result = await executeImpact({ cwd: '/proj', json: true, files: ['src/callee.ts'] }, cli);

    expect(result.catalog?.cacheKeyDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.catalog?.filesFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(result)).not.toContain('/private/repo');
    datastore.close();
  });

  it.each(['cacheKey', 'filesFingerprint'] as const)(
    'omits catalog identity when a legacy catalog has no %s',
    async (missingField) => {
      const datastore = DataStoreFactory.open({ backend: 'memory' });
      const complete = makeCatalog();
      let incomplete;
      if (missingField === 'cacheKey') {
        const { cacheKey, ...catalog } = complete;
        void cacheKey;
        incomplete = catalog;
      } else {
        const { filesFingerprint, ...catalog } = complete;
        void filesFingerprint;
        incomplete = catalog;
      }
      // Impact loads via loadFullCatalog for freshness; mock both entry points.
      const loadFull = vi
        .spyOn(CatalogRepo.prototype, 'loadFullCatalog')
        .mockReturnValue(incomplete as never);
      const load = vi
        .spyOn(CatalogRepo.prototype, 'loadCatalogContract')
        .mockReturnValue(incomplete);

      try {
        const result = await executeImpact(
          { cwd: '/proj', json: true, files: ['src/callee.ts'] },
          mockCli(datastore),
        );

        expect(result.catalog).toBeUndefined();
      } finally {
        loadFull.mockRestore();
        load.mockRestore();
        datastore.close();
      }
    },
  );

  it('--changed outside a git repo throws ConfigurationError', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opensip-impact-nogit-'));
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    await expect(
      executeImpact({ cwd: dir, json: true, changed: true }, cli),
    ).rejects.toBeInstanceOf(ConfigurationError);
    datastore.close();
  });

  it('requires an explicit changed-file basis', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    await expect(executeImpact({ cwd: '/proj', json: true }, cli)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
    datastore.close();
  });

  it('requires a datastore on the CLI context', async () => {
    const cli = mockCli();
    await expect(
      executeImpact({ cwd: '/proj', json: true, files: ['src/callee.ts'] }, cli),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('wraps unexpected context failures as SystemError', async () => {
    const cli = {
      setExitCode: vi.fn(),
      emitJson: vi.fn(),
      emitRaw: vi.fn(),
      render: vi.fn().mockResolvedValue(undefined),
      scope: {
        datastore: () => {
          throw new Error('scope exploded');
        },
      },
    } as unknown as ToolCliContext;

    let caught: unknown;
    try {
      await executeImpact({ cwd: '/proj', json: true, files: ['src/callee.ts'] }, cli);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SystemError);
    expect((caught as Error).message).toContain('scope exploded');
  });

  it('rejects path traversal in --files (matches nothing, no filesystem read)', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    const result = await executeImpact(
      {
        cwd: mkdtempSync(join(tmpdir(), 'opensip-impact-traversal-')),
        json: true,
        files: ['../../etc/passwd'],
      },
      cli,
    );
    expect(result.changedFunctions).toHaveLength(0);
    expect(result.impactedFunctions).toHaveLength(0);
    expect(result.trust.fullyVerified).toBe(false);
    expect(result.trust.uncertainties.map((item) => item.code)).toContain('changed-file-unmatched');
    datastore.close();
  });

  it('applies --top cap and sets truncated', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    const result = await executeImpact(
      {
        cwd: '/proj',
        json: true,
        files: ['src/callee.ts'],
        top: '1',
      },
      cli,
    );
    expect(result.truncated).toBe(true);
    expect(result.trust.uncertainties.map((item) => item.code)).toContain('impact-truncated');
    datastore.close();
  });

  it('rejects invalid --top values before emitting output', async () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    new CatalogRepo(datastore).replaceAll(makeCatalog());
    const cli = mockCli(datastore);
    await expect(
      executeImpact({ cwd: '/proj', json: true, files: ['src/callee.ts'], top: 'abc' }, cli),
    ).rejects.toBeInstanceOf(ConfigurationError);
    expect(cli.emitJson).not.toHaveBeenCalled();
    datastore.close();
  });

  it('declares --files as a repeatable parser on the command spec', () => {
    const filesOption = graphImpactCommandSpec.options?.find((option) => option.flag === '--files');
    expect(filesOption?.arrayDefault).toEqual([]);
    expect(filesOption?.parse?.('src/a.ts', [])).toEqual(['src/a.ts']);
    expect(filesOption?.parse?.('src/b.ts', ['src/a.ts'])).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('declares graph impact as a verdict-producing command for suites', () => {
    expect(graphImpactCommandSpec.producesVerdict).toBe(true);
  });
});
