import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT_CODES } from '@opensip-cli/contracts';
import { RunScope, runWithScope, runWithScopeSync } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { collectYagniReportData } from '../cli/report-data.js';
import { yagniCommandSpec } from '../cli/yagni-command-spec.js';
import { YagniConfigSchema, yagniConfigDeclaration } from '../cli/yagni-config-schema.js';
import { loadYagniConfig } from '../cli/yagni-config.js';
import {
  buildYagniRunPresentation,
  buildYagniPresentationLines,
} from '../cli/yagni-presentation.js';
import { createYagniSignal } from '../detectors/create-yagni-signal.js';
import { duplicateBodyCandidateDetector } from '../detectors/duplicate-body-candidate.js';
import { unusedConfigSurfaceDetector } from '../detectors/unused-config-surface.js';
import { resolveYagniPositionalPaths } from '../lib/resolve-positional-paths.js';
import { buildYagniSessionPayload } from '../persistence/session-payload.js';
import {
  buildYagniRunSummary,
  filterByMinConfidence,
  filterByReductionCategories,
  readYagniMetadata,
  severityForConfidence,
  sortYagniSignals,
} from '../scoring/confidence.js';
import { YAGNI_CONTRACT_VERSION, YAGNI_STABLE_ID, yagniTool } from '../tool.js';

import type { GraphCatalog, GraphFunctionOccurrence, SignalEnvelope } from '@opensip-cli/contracts';
import type { Signal, ToolCliContext } from '@opensip-cli/core';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, 'fixtures', 'unused-config-surface', 'pkg');

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'opensip-yagni-test-'));
}

function makeCli(): ToolCliContext & { _state: { code?: number } } {
  const state: { code?: number } = {};
  return {
    scope: { datastore: () => undefined },
    emitEnvelope: vi.fn(),
    emitJson: vi.fn(),
    emitError: vi.fn(),
    render: vi.fn(() => Promise.resolve()),
    renderLive: vi.fn(() => Promise.resolve()),
    registerLiveView: vi.fn(),
    setExitCode: vi.fn((code: number) => {
      state.code = code;
    }),
    getExitCode: vi.fn(() => state.code),
    deliverSignals: vi.fn(() => Promise.resolve({ delivered: false })),
    writeSarif: vi.fn(() => Promise.resolve()),
    maybeOpenReport: vi.fn(() => Promise.resolve()),
    _state: state,
  } as unknown as ToolCliContext & { _state: { code?: number } };
}

function signal(
  id: string,
  confidence: 'low' | 'medium' | 'high',
  netEstimate: number,
  estimateKind: 'exact' | 'lower-bound' | 'heuristic',
  category = 'config',
): Signal {
  return createYagniSignal({
    source: `yagni:${id}`,
    ruleId: `yagni:${id}`,
    severity: severityForConfidence(confidence),
    category: 'quality',
    message: id,
    suggestion: `fix ${id}`,
    code: { file: `/repo/${id}.ts`, line: netEstimate, column: 1 },
    yagni: {
      detector: id,
      reductionCategory: category as never,
      confidence,
      locDelta: {
        remove: netEstimate,
        add: 0,
        netEstimate,
        estimateKind,
      },
      preservationArgument: 'covered by test',
      suggestedAction: `fix ${id}`,
      validationRequired: ['run tests'],
      riskTags: [],
      evidence: [{ id, kind: 'test', summary: id }],
    },
  });
}

function graphOccurrence(
  overrides: Pick<
    GraphFunctionOccurrence,
    'bodyHash' | 'column' | 'endLine' | 'filePath' | 'line' | 'qualifiedName' | 'simpleName'
  > &
    Partial<GraphFunctionOccurrence>,
): GraphFunctionOccurrence {
  return {
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'exported',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
    ...overrides,
  };
}

function envelope(input: {
  readonly signals: readonly Signal[];
  readonly units?: SignalEnvelope['units'];
  readonly summary?: SignalEnvelope['verdict']['summary'];
}): SignalEnvelope {
  const summary = input.summary ?? {
    total: input.units?.length ?? 0,
    passed: input.units?.filter((unit) => unit.passed).length ?? 0,
    failed: input.units?.filter((unit) => !unit.passed).length ?? 0,
    errors: 0,
    warnings: input.signals.length,
  };
  return {
    schemaVersion: 2,
    tool: 'yagni',
    runId: 'test-run',
    createdAt: '2026-06-22T00:00:00.000Z',
    verdict: { score: 1, passed: summary.errors === 0, summary },
    units: input.units ?? [],
    signals: input.signals,
  };
}

async function runCommandInScope(
  scope: RunScope,
  rawOpts: unknown,
  cli: ToolCliContext,
): Promise<void> {
  await runWithScope(scope, async () => {
    await yagniCommandSpec.handler(rawOpts, cli);
  });
}

describe('yagni config, tool metadata, and command handler', () => {
  it('loads config from scope first, then YAML fallback, then defaults', () => {
    const scoped = new RunScope();
    Object.assign(scoped, {
      toolConfig: {
        yagni: {
          graphMode: 'off',
          defaultMinConfidence: 'high',
          includeTests: true,
          disabledDetectors: ['x'],
        },
      },
    });

    const scopedConfig = runWithScopeSync(scoped, () => loadYagniConfig('/unused'));
    expect(scopedConfig).toMatchObject({
      graphMode: 'off',
      defaultMinConfidence: 'high',
      includeTests: true,
      disabledDetectors: ['x'],
    });

    const emptyScope = new RunScope();
    expect(runWithScopeSync(emptyScope, () => loadYagniConfig('/unused'))).toMatchObject({
      graphMode: 'auto',
      defaultMinConfidence: 'medium',
      includeTests: false,
    });

    const dir = tempDir();
    writeFileSync(
      join(dir, 'opensip-cli.config.yml'),
      [
        'schemaVersion: 1',
        'yagni:',
        '  graphMode: reuse',
        '  defaultMinConfidence: low',
        '  failOnWarnings: 2',
        '  detectorSettings:',
        '    duplicate-body-candidate:',
        '      minOccurrences: 3',
      ].join('\n'),
    );
    expect(loadYagniConfig(dir)).toMatchObject({
      graphMode: 'reuse',
      defaultMinConfidence: 'low',
      failOnWarnings: 2,
      detectorSettings: { 'duplicate-body-candidate': { minOccurrences: 3 } },
    });

    const invalidDir = tempDir();
    writeFileSync(join(invalidDir, 'opensip-cli.config.yml'), 'schemaVersion: 1\nyagni: nope\n');
    expect(loadYagniConfig(invalidDir)).toMatchObject({ graphMode: 'auto' });
  });

  it('exports config schema, report data, and tool metadata', () => {
    expect(
      YagniConfigSchema.parse({
        failOnErrors: 1,
        failOnWarnings: 0,
        defaultMinConfidence: 'medium',
        graphMode: 'build',
        includeTests: false,
        disabledDetectors: ['duplicate-body-candidate'],
        detectorSettings: { 'duplicate-body-candidate': { minBodyLines: 8 } },
      }),
    ).toMatchObject({ graphMode: 'build' });
    expect(YagniConfigSchema.safeParse({ graphMode: 'sometimes' }).success).toBe(false);
    expect(yagniConfigDeclaration.env?.map((entry) => entry.envVar)).toContain(
      'OPENSIP_YAGNI_GRAPH_MODE',
    );

    const reportData = collectYagniReportData({} as never);
    expect(reportData.yagniSummary).toMatchObject({
      detectorCount: 2,
      graphBackedCount: 1,
      contractVersion: YAGNI_CONTRACT_VERSION,
    });
    expect(reportData.yagniCatalog).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: 'yagni:unused-config-surface' })]),
    );

    expect(yagniTool.metadata).toMatchObject({
      id: YAGNI_STABLE_ID,
      name: 'yagni',
    });
    expect(yagniTool.commandSpecs).toContain(yagniCommandSpec);
    expect(yagniTool.extensionPoints?.collectReportData).toBe(collectYagniReportData);
  });

  it('runs the command handler in JSON and human modes', async () => {
    const jsonCli = makeCli();
    const scope = new RunScope();
    Object.assign(scope, {
      toolConfig: { yagni: { graphMode: 'off', defaultMinConfidence: 'low' } },
    });
    await runCommandInScope(
      scope,
      {
        cwd: FIXTURE_ROOT,
        json: true,
        graph: 'off',
        minConfidence: 'low',
        includeTests: true,
        detector: ['unused-config-surface'],
        _args: [[join(FIXTURE_ROOT, 'src')]],
      },
      jsonCli,
    );
    expect(jsonCli.emitEnvelope).toHaveBeenCalledOnce();
    expect(jsonCli.render).not.toHaveBeenCalled();
    expect(jsonCli.deliverSignals).toHaveBeenCalledOnce();
    expect(jsonCli.maybeOpenReport).toHaveBeenCalledWith({
      openRequested: false,
      jsonOutput: true,
    });
    expect(jsonCli._state.code).toBe(EXIT_CODES.SUCCESS);

    const humanCli = makeCli();
    await runCommandInScope(
      scope,
      {
        cwd: FIXTURE_ROOT,
        verbose: true,
        graph: 'invalid',
        minConfidence: 'invalid',
        category: 'config',
        includeTests: true,
      },
      humanCli,
    );
    expect(humanCli.emitEnvelope).not.toHaveBeenCalled();
    expect(humanCli.render).toHaveBeenCalledOnce();
    expect(humanCli.maybeOpenReport).toHaveBeenCalledWith({
      openRequested: false,
      jsonOutput: false,
    });
  });
});

describe('yagni detectors and scoring helpers', () => {
  it('emits duplicate-body candidates from graph body hashes', async () => {
    const catalog: GraphCatalog = {
      version: '1',
      tool: 'graph',
      language: 'typescript',
      builtAt: '2026-06-22T00:00:00.000Z',
      functions: {
        a: [
          graphOccurrence({
            qualifiedName: 'pkgA.alpha',
            simpleName: 'alpha',
            filePath: join(FIXTURE_ROOT, 'src', 'a.ts'),
            line: 10,
            column: 2,
            endLine: 18,
            bodyHash: 'same-body-hash',
            package: '@opensip-cli/a',
          }),
        ],
        b: [
          graphOccurrence({
            qualifiedName:
              'pkgB.strip.test.<arrow:packages/languages/lang-python/src/__tests__/strip.test.ts:69:29>',
            simpleName: '<arrow:packages/languages/lang-python/src/__tests__/strip.test.ts:69:29>',
            filePath: join(FIXTURE_ROOT, 'src', 'b.ts'),
            line: 20,
            column: 4,
            endLine: 28,
            bodyHash: 'same-body-hash',
            package: '@opensip-cli/b',
          }),
          graphOccurrence({
            qualifiedName: 'pkgB.short',
            simpleName: 'short',
            filePath: join(FIXTURE_ROOT, 'src', 'short.ts'),
            line: 1,
            column: 1,
            endLine: 2,
            bodyHash: 'short-body-hash',
          }),
        ],
      },
    };

    const result = await duplicateBodyCandidateDetector.run({
      cwd: FIXTURE_ROOT,
      config: { detectorSettings: { 'duplicate-body-candidate': { minBodyLines: 3 } } },
      graphCatalog: catalog,
      includeTests: false,
    });

    expect(result.signals).toHaveLength(1);
    const metadata =
      result.signals[0] === undefined ? undefined : readYagniMetadata(result.signals[0]);
    const suggestedAction = metadata?.suggestedAction ?? '';
    expect(suggestedAction).toBe('Consolidate with src/b.ts:20 (arrow function).');
    expect(suggestedAction).not.toContain('<arrow:');
    expect(metadata).toMatchObject({
      detector: 'duplicate-body-candidate',
      reductionCategory: 'dedupe',
      confidence: 'medium',
      evidence: [
        expect.objectContaining({
          data: expect.objectContaining({
            occurrenceCount: 2,
            packages: ['@opensip-cli/a', '@opensip-cli/b'],
            peer: expect.objectContaining({
              qualifiedName:
                'pkgB.strip.test.<arrow:packages/languages/lang-python/src/__tests__/strip.test.ts:69:29>',
            }),
          }),
        }),
      ],
    });

    const noGraph = await duplicateBodyCandidateDetector.run({
      cwd: FIXTURE_ROOT,
      config: {},
      graphCatalog: null,
      includeTests: false,
    });
    expect(noGraph.signals).toEqual([]);
  });

  it('formats duplicate-body peer names for human CLI output', async () => {
    function pair(
      bodyHash: string,
      peer: Partial<GraphFunctionOccurrence>,
    ): GraphFunctionOccurrence[] {
      return [
        graphOccurrence({
          qualifiedName: `${bodyHash}.anchor`,
          simpleName: 'anchor',
          filePath: join(FIXTURE_ROOT, 'src', `${bodyHash}-anchor.ts`),
          line: 10,
          column: 1,
          endLine: 16,
          bodyHash,
        }),
        graphOccurrence({
          qualifiedName: `zz.${bodyHash}`,
          simpleName: 'peer',
          filePath: join(FIXTURE_ROOT, 'src', `${bodyHash}-peer.ts`),
          line: 30,
          column: 1,
          endLine: 36,
          bodyHash,
          ...peer,
        }),
      ];
    }

    const catalog: GraphCatalog = {
      version: '1',
      tool: 'graph',
      language: 'typescript',
      builtAt: '2026-06-22T00:00:00.000Z',
      functions: {
        normal: pair('normal', { simpleName: 'namedHelper' }),
        qualifiedArrow: pair('qualified-arrow', {
          simpleName: 'packages/example/src/file.ts',
          qualifiedName: 'zz.qualified.<arrow:packages/example/src/file.ts:5:9>',
        }),
        qualifiedTail: pair('qualified-tail', {
          simpleName: 'packages/example/src/file.ts',
          qualifiedName: 'zz.qualified.namedTail',
        }),
        fallback: pair('fallback', {
          simpleName: 'packages/example/src/file.ts',
          qualifiedName: 'zz.qualified.packages/example/src/file.ts',
        }),
      },
    };

    const result = await duplicateBodyCandidateDetector.run({
      cwd: FIXTURE_ROOT,
      config: { detectorSettings: { 'duplicate-body-candidate': { minBodyLines: 3 } } },
      graphCatalog: catalog,
      includeTests: false,
    });

    const actions = result.signals
      .map((signal) => readYagniMetadata(signal)?.suggestedAction)
      .filter((action): action is string => action !== undefined);
    expect(actions).toEqual(
      expect.arrayContaining([
        'Consolidate with src/normal-peer.ts:30 (namedHelper).',
        'Consolidate with src/qualified-arrow-peer.ts:30 (arrow function).',
        'Consolidate with src/qualified-tail-peer.ts:30 (namedTail).',
        'Consolidate with src/fallback-peer.ts:30 (function).',
      ]),
    );
    expect(actions.join('\n')).not.toContain('<arrow:');
  });

  it('sorts, filters, summarizes, and persists YAGNI signal metadata', () => {
    const high = signal('high', 'high', 5, 'exact', 'config');
    const medium = signal('medium', 'medium', 8, 'heuristic', 'dedupe');
    const low = signal('low', 'low', 20, 'lower-bound', 'config');
    const plain = {
      ...high,
      id: 'plain',
      source: 'plain',
      ruleId: 'plain',
      metadata: {},
      filePath: '',
      line: undefined,
      column: undefined,
      suggestion: undefined,
    } as Signal;

    expect(readYagniMetadata(plain)).toBeUndefined();
    expect(filterByMinConfidence([low, medium, high, plain], 'medium')).toEqual([
      medium,
      high,
      plain,
    ]);
    expect(filterByReductionCategories([low, medium, high, plain], ['config'])).toEqual([
      low,
      high,
      plain,
    ]);
    expect(filterByReductionCategories([low, medium], [])).toEqual([low, medium]);
    expect(sortYagniSignals([plain, low, medium, high]).map((s) => s.ruleId)).toEqual([
      'yagni:high',
      'yagni:medium',
      'yagni:low',
      'plain',
    ]);

    const summary = buildYagniRunSummary([low, medium, high, plain], 'reuse', [
      { id: 'skipped', slug: 'yagni:skipped', reason: 'disabled' },
      { id: 'graph', slug: 'yagni:graph', reason: 'graph-required', detail: 'missing' },
    ]);
    expect(summary).toMatchObject({
      totalCandidates: 4,
      byConfidence: { high: 1, medium: 1, low: 1 },
      estimatedTotalLocReduction: 33,
      graphMode: 'reuse',
    });
    expect(summary.skippedDetectors).toEqual([
      { slug: 'yagni:skipped', reason: 'disabled' },
      { slug: 'yagni:graph', reason: 'graph-required', detail: 'missing' },
    ]);

    const payload = buildYagniSessionPayload(
      envelope({
        signals: [high],
        units: [{ slug: high.source, passed: false, violationCount: 1, durationMs: 7 }],
        summary: { total: 1, passed: 0, failed: 1, errors: 0, warnings: 1 },
      }),
      [],
      {
        graphMode: 'reuse',
        graphBuilt: false,
        yagniSummary: summary,
      },
    );
    expect(payload.checks[0]).toMatchObject({
      checkSlug: high.source,
      violationCount: 1,
      findings: [expect.objectContaining({ severity: 'warning', metadata: high.metadata })],
    });
    expect(payload.summary.graphDetail).toBeUndefined();

    const errorFinding = {
      ...high,
      severity: 'high',
      line: undefined,
      column: undefined,
      suggestion: undefined,
    } as Signal;
    const duplicateSource = { ...medium, source: high.source } as Signal;
    const detailedPayload = buildYagniSessionPayload(
      envelope({
        signals: [errorFinding, duplicateSource],
        units: [{ slug: high.source, passed: false, durationMs: 9 }],
        summary: { total: 1, passed: 0, failed: 1, errors: 1, warnings: 1 },
      }),
      [],
      {
        graphMode: 'build',
        graphBuilt: true,
        graphDetail: 'built fresh catalog',
        yagniSummary: summary,
      },
    );
    expect(detailedPayload.checks[0]).toMatchObject({
      violationCount: 2,
      findings: [
        expect.objectContaining({ severity: 'error' }),
        expect.objectContaining({ severity: 'warning' }),
      ],
    });
    expect(detailedPayload.checks[0]?.findings[0]).not.toHaveProperty('line');
    expect(detailedPayload.checks[0]?.findings[0]).not.toHaveProperty('suggestion');
    expect(detailedPayload.summary.graphDetail).toBe('built fresh catalog');
  });

  it('covers presentation variants and unreadable/oversized source skips', async () => {
    const outcome = await unusedConfigSurfaceDetector.run({
      cwd: FIXTURE_ROOT,
      config: {},
      graphCatalog: null,
      includeTests: true,
      pathRoots: [join(FIXTURE_ROOT, 'src')],
    });
    expect(outcome.signals).toHaveLength(1);

    const dir = tempDir();
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'src', 'huge-config.ts'),
      `export interface HugeConfig {\n${'x'.repeat(1_000_020)}\n}`,
    );
    const skipped = await unusedConfigSurfaceDetector.run({
      cwd: dir,
      config: {},
      graphCatalog: null,
      includeTests: false,
      pathRoots: [join(dir, 'src')],
    });
    expect(skipped.signals).toEqual([]);

    const verboseLines = buildYagniPresentationLines(
      envelope({
        units: [{ slug: 'yagni:unused-config-surface', passed: true, durationMs: 1 }],
        signals: outcome.signals,
        summary: { total: 1, passed: 0, failed: 1, errors: 0, warnings: 1 },
      }),
      FIXTURE_ROOT,
      'off',
      [{ id: 'x', slug: 'yagni:x', reason: 'disabled', detail: 'configured' }],
      true,
    );
    expect(verboseLines.join('\n')).toContain('Skipped detectors');

    const presentation = buildYagniRunPresentation({
      envelope: envelope({
        signals: [],
        summary: { total: 0, passed: 1, failed: 0, errors: 0, warnings: 0 },
      }),
      cwd: FIXTURE_ROOT,
      graphMode: 'off',
      skippedDetectors: [],
      verbose: false,
      durationMs: 12,
    });
    expect(presentation.envelope.verdict.summary).toMatchObject({ total: 0, warnings: 0 });

    const highNoDetails = signal('no-details', 'high', 0, 'exact');
    const metadata = readYagniMetadata(highNoDetails);
    const sparse = {
      ...highNoDetails,
      filePath: '',
      line: undefined,
      metadata: {
        yagni:
          metadata === undefined
            ? undefined
            : {
                ...metadata,
                locDelta: undefined,
                validationRequired: [],
                riskTags: [],
                evidence: [],
              },
      },
    } as Signal;
    const noMetadata = { ...sparse, metadata: {} } as Signal;
    const sparseLines = buildYagniPresentationLines(
      envelope({
        signals: [noMetadata, sparse],
        units: [{ slug: 'yagni:sparse', passed: false, durationMs: 1 }],
      }),
      FIXTURE_ROOT,
      'reuse',
      [{ id: 'plain', slug: 'yagni:plain', reason: 'disabled' }],
      true,
    );
    const sparseText = sparseLines.join('\n');
    expect(sparseText).toContain('<unknown>');
    expect(sparseText).toContain('yagni:plain: disabled');
    expect(sparseText).not.toContain('validation:');
  });
});

describe('yagni positional path resolution', () => {
  it('resolves directories and rejects invalid positionals', () => {
    const dir = tempDir();
    const nested = join(dir, 'nested');
    mkdirSync(nested);
    writeFileSync(join(dir, 'file.ts'), 'export const x = 1;\n');

    expect(resolveYagniPositionalPaths(['nested', nested], dir)).toEqual([nested, nested]);
    expect(() => resolveYagniPositionalPaths(['  '], dir)).toThrow(/empty/);
    expect(() => resolveYagniPositionalPaths(['missing'], dir)).toThrow(/does not exist/);
    expect(() => resolveYagniPositionalPaths(['file.ts'], dir)).toThrow(/not a directory/);
  });
});
