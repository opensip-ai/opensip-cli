import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT_CODES } from '@opensip-cli/contracts';
import { resolveToolHooks, RunScope, runWithScope, runWithScopeSync } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { collectYagniReportData } from '../cli/report-data.js';
import { buildYagniCommandSpec } from '../cli/yagni-command-spec.js';
import { YagniConfigSchema, yagniConfigDeclaration } from '../cli/yagni-config-schema.js';
import { loadYagniConfig } from '../cli/yagni-config.js';
import {
  buildYagniRunPresentation,
  buildYagniPresentationLines,
} from '../cli/yagni-presentation.js';
import { createYagniSignal } from '../detectors/create-yagni-signal.js';
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

import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { Signal, ToolCliContext } from '@opensip-cli/core';

const yagniCommandSpec = buildYagniCommandSpec(() => {
  // coverage tests use the static handler path
});

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
    reportFailure: vi.fn(() => Promise.resolve()),
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
    repair: {
      repairKind: 'manual',
      autofixable: false,
      confidence: 0.5,
      patchHint: { kind: 'text', summary: `fix ${id}`, target: `/repo/${id}.ts` },
    },
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
      validationRequired: ['run tests'],
      riskTags: [],
      evidence: [{ id, kind: 'test', summary: id }],
    },
  });
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
    baselineIdentity: {
      fingerprintStrategyId: 'yagni.sha256-detector-locations',
      fingerprintStrategyVersion: 1,
    },
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
          defaultMinConfidence: 'high',
          includeTests: true,
          disabledDetectors: ['x'],
        },
      },
    });

    const scopedConfig = runWithScopeSync(scoped, () => loadYagniConfig('/unused'));
    expect(scopedConfig).toMatchObject({
      defaultMinConfidence: 'high',
      includeTests: true,
      disabledDetectors: ['x'],
    });

    const emptyScope = new RunScope();
    expect(runWithScopeSync(emptyScope, () => loadYagniConfig('/unused'))).toMatchObject({
      defaultMinConfidence: 'medium',
      includeTests: false,
    });

    const dir = tempDir();
    writeFileSync(
      join(dir, 'opensip-cli.config.yml'),
      [
        'schemaVersion: 1',
        'yagni:',
        '  defaultMinConfidence: low',
        '  failOnWarnings: 2',
        '  detectorSettings:',
        '    unused-config-surface:',
        '      someKnob: 3',
      ].join('\n'),
    );
    expect(loadYagniConfig(dir)).toMatchObject({
      defaultMinConfidence: 'low',
      failOnWarnings: 2,
      detectorSettings: { 'unused-config-surface': { someKnob: 3 } },
    });

    const invalidDir = tempDir();
    writeFileSync(join(invalidDir, 'opensip-cli.config.yml'), 'schemaVersion: 1\nyagni: nope\n');
    expect(loadYagniConfig(invalidDir)).toMatchObject({
      defaultMinConfidence: 'medium',
    });
  });

  it('exports config schema, report data, and tool metadata', () => {
    expect(
      YagniConfigSchema.parse({
        failOnErrors: 1,
        failOnWarnings: 0,
        defaultMinConfidence: 'medium',
        includeTests: false,
        disabledDetectors: ['unused-config-surface'],
        detectorSettings: { 'unused-config-surface': { someKnob: 8 } },
      }),
    ).toMatchObject({ defaultMinConfidence: 'medium' });
    expect(YagniConfigSchema.safeParse({ graphMode: 'build' }).success).toBe(false);
    expect(yagniConfigDeclaration.env?.map((entry) => entry.envVar)).toContain(
      'OPENSIP_YAGNI_MIN_CONFIDENCE',
    );

    const reportData = collectYagniReportData({} as never);
    expect(reportData.yagniSummary).toMatchObject({
      detectorCount: 2,
      contractVersion: YAGNI_CONTRACT_VERSION,
    });
    expect(reportData.yagniCatalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'yagni:unused-config-surface' }),
        expect.objectContaining({ slug: 'yagni:duplicate-body-candidate' }),
      ]),
    );

    expect(yagniTool.metadata).toMatchObject({
      id: YAGNI_STABLE_ID,
      name: 'yagni',
    });
    expect(yagniTool.commandSpecs?.[0]?.name).toBe('yagni');
    expect(yagniTool.commandSpecs?.[0]?.aliases).toEqual(['yag']);
    expect(yagniTool.extensionPoints?.collectReportData).toBe(collectYagniReportData);
    expect(resolveToolHooks(yagniTool).sessionReplay?.tool).toBe('yagni');
  });

  it('runs the command handler in JSON and human modes', async () => {
    const jsonCli = makeCli();
    const scope = new RunScope();
    Object.assign(scope, {
      toolConfig: { yagni: { defaultMinConfidence: 'low' } },
    });
    await runCommandInScope(
      scope,
      {
        cwd: FIXTURE_ROOT,
        json: true,
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
    const detectorTieA = signal('alpha', 'medium', 10, 'exact', 'config');
    const detectorTieB = signal('beta', 'medium', 10, 'exact', 'config');
    expect(sortYagniSignals([detectorTieB, detectorTieA]).map((s) => s.ruleId)).toEqual([
      'yagni:alpha',
      'yagni:beta',
    ]);

    const summary = buildYagniRunSummary(
      [low, medium, high, plain],
      [{ id: 'skipped', slug: 'yagni:skipped', reason: 'disabled' }],
    );
    expect(summary).toMatchObject({
      totalCandidates: 4,
      byConfidence: { high: 1, medium: 1, low: 1 },
      estimatedTotalLocReduction: 33,
    });
    expect(summary.skippedDetectors).toEqual([{ slug: 'yagni:skipped', reason: 'disabled' }]);

    const payload = buildYagniSessionPayload(
      envelope({
        signals: [high],
        units: [
          {
            slug: high.source,
            passed: false,
            violationCount: 1,
            durationMs: 7,
          },
        ],
        summary: { total: 1, passed: 0, failed: 1, errors: 0, warnings: 1 },
      }),
      [],
      summary,
    );
    expect(payload.checks[0]).toMatchObject({
      checkSlug: high.source,
      violationCount: 1,
      findings: [
        expect.objectContaining({
          severity: 'warning',
          metadata: high.metadata,
        }),
      ],
    });
    expect(payload.summary).not.toHaveProperty('graphMode');
    expect(payload.summary).not.toHaveProperty('graphBuilt');
    expect(payload.summary).not.toHaveProperty('graphDetail');

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
      summary,
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
    expect(detailedPayload.summary).not.toHaveProperty('graphDetail');
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
      skippedDetectors: [],
      verbose: false,
      durationMs: 12,
    });
    expect(presentation.envelope.verdict.summary).toMatchObject({
      total: 0,
      warnings: 0,
    });

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
