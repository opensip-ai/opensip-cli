import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { MAX_CHANGE_IMPACT_MODELS_BYTES } from '../change-impact/project.js';
import { generateDashboardHtml } from '../generator.js';

import type { DashboardRun } from '../generator.js';
import type { GraphCatalog, ReviewBrief, StoredSession } from '@opensip-cli/contracts';

const BUILT_AT = '2026-07-12T00:00:00.000Z';
const CACHE_KEY = 'artifact-catalog-key';
const FILES_FINGERPRINT = '1\nsrc/change.ts|1|1';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function catalog(filePath = 'src/change.ts', qualifiedName = 'src.changed'): GraphCatalog {
  return {
    version: '2.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: BUILT_AT,
    cacheKey: CACHE_KEY,
    filesFingerprint: FILES_FINGERPRINT,
    resolutionMode: 'exact',
    functions: {
      changed: [
        {
          bodyHash: 'body-changed',
          simpleName: 'changed',
          qualifiedName,
          filePath,
          line: 1,
          column: 0,
          endLine: 2,
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
    },
  };
}

function brief(marker: string, filePath: string): ReviewBrief {
  const risk = {
    source: 'fit',
    ruleId: `risk-${marker}`,
    message: `risk ${marker}`,
    severity: 'high' as const,
    file: filePath,
    line: 1,
    isNew: true,
    signalRef: {
      tool: 'fit',
      suiteRunId: 'suite-artifact',
      stepIndex: 0,
      signalIndex: 0,
    },
  };
  const ref = {
    source: risk.source,
    ruleId: risk.ruleId,
    file: risk.file,
    line: risk.line,
    signalRef: risk.signalRef,
  };
  return {
    version: 1,
    suite: 'audit',
    suiteRunId: 'suite-artifact',
    verdict: 'warn',
    changedFiles: 1,
    topRisks: [risk],
    newFindings: [],
    baselineDelta: { available: true, added: 1, removed: 0, unchanged: 0 },
    degraded: [{ source: 'graph', reason: `degraded ${marker}` }],
    recommendedActions: [
      { priority: 'high', message: `action ${marker}`, command: `opensip ${marker}` },
    ],
    correlatedRisks: [
      {
        id: 'correlation-artifact',
        title: `correlation ${marker}`,
        severity: 'high',
        isNew: true,
        primary: ref,
        members: [ref],
        entities: [],
        reasons: [
          {
            kind: 'same-file',
            key: { kind: 'file', value: filePath, confidence: 'high' },
            confidence: 'high',
            message: `reason ${marker}`,
          },
        ],
      },
    ],
  };
}

function impact(marker: string, filePath: string, qualifiedName: string): Record<string, unknown> {
  return {
    catalog: {
      builtAt: BUILT_AT,
      language: 'typescript',
      filesFingerprint: digest(FILES_FINGERPRINT),
      resolutionMode: 'exact',
      cacheKeyDigest: digest(CACHE_KEY),
    },
    basis: { type: 'files', warningCodes: [] },
    changedFiles: [filePath],
    changedFunctions: [
      {
        qualifiedName,
        filePath,
        line: 1,
        package: `package-${marker}`,
        reason: `changed ${marker}`,
      },
    ],
    impactedFunctions: [],
    impactedFiles: [],
    impactedPackages: [{ name: `package-${marker}`, functionCount: 1 }],
    trust: {
      coverage: 'partial',
      fallback: 'targeted',
      fullyVerified: false,
      uncertainties: [
        { code: 'artifact-uncertainty', source: 'files', message: `uncertain ${marker}`, filePath },
      ],
    },
    recommendedCommands: [`opensip fit ${marker}`],
    truncated: false,
    omitted: {
      changedFiles: 0,
      changedFunctions: 0,
      impactedFunctions: 0,
      impactedFiles: 0,
      impactedPackages: 0,
      recommendedCommands: 0,
    },
    detailTruncated: false,
    metadataOmitted: false,
  };
}

function session(id: string, impactPayload: Record<string, unknown>): StoredSession {
  return {
    id,
    tool: 'graph',
    cwd: '/repo',
    startedAt: BUILT_AT,
    completedAt: BUILT_AT,
    durationMs: 10,
    score: 100,
    passed: true,
    payload: { __version: 1, impactStatus: 'available', impact: impactPayload },
  };
}

function run(
  id: string,
  sessionId: string,
  reviewBrief: ReviewBrief,
  notice: string,
): DashboardRun {
  return {
    id,
    name: 'audit',
    source: 'built-in-suite',
    cwd: '/repo',
    startedAt: BUILT_AT,
    completedAt: BUILT_AT,
    durationMs: 10,
    exitCode: 0,
    aggregate: { steps: 1, passed: 1, failed: 0, faulted: 0, errors: 0, warnings: 1 },
    scope: { mode: 'changed', source: 'explicit', changedFiles: 1, notice },
    reviewBrief,
    steps: [
      {
        id: 'step-artifact',
        runId: id,
        logicalStepKey: '1:graph:impact',
        ordinal: 1,
        attempt: 1,
        tool: 'graph',
        command: 'impact',
        stableId: 'graph',
        exitCode: 0,
        outcome: 'passed',
        durationMs: 10,
        sessionId,
      },
    ],
  };
}

describe('Change Impact artifact safety and bounds', () => {
  it('escapes every string-bearing evidence family and embeds the stylesheet once', () => {
    const marker = '</script><script>globalThis.__artifactInjected=true</script>';
    const filePath = `src/risk-${marker}.ts`;
    const qualifiedName = `src.${marker}`;
    const graphCatalog = catalog(filePath, qualifiedName);
    const graphSession = session('session-artifact', impact(marker, filePath, qualifiedName));
    const auditRun = run(
      `RUN_${marker}`,
      graphSession.id,
      brief(marker, filePath),
      `scope ${marker}`,
    );

    const html = generateDashboardHtml({
      sessions: [graphSession],
      runs: [auditRun],
      graphCatalog,
    });

    expect(html).not.toContain(marker);
    expect(html.match(/\/\* ====== Change Impact report ====== \*\//gu)).toHaveLength(1);
    expect(html).not.toContain('fetch(');
    expect(html).not.toMatch(/<script[^>]+src=/iu);
    expect(html).toContain(String.raw`\u003c/script\u003e`);
  });

  it('does not duplicate ReviewBrief or graph impact payloads outside bounded models', () => {
    const marker = 'ONLY_BOUNDED_REVIEW_SENTINEL';
    const graphCatalog = catalog();
    const graphSession = session('session-bounded', {
      ...impact('bounded', 'src/change.ts', 'src.changed'),
      duplicateBlob: 'DUPLICATE_IMPACT_SENTINEL',
    });
    const auditRun = run(
      'RUN_bounded',
      graphSession.id,
      brief(marker, 'src/change.ts'),
      'bounded scope',
    );

    const html = generateDashboardHtml({
      sessions: [graphSession],
      runs: [auditRun],
      graphCatalog,
    });

    const overviewRuns = /const runs = ([^;]+);/u.exec(html)?.[1] ?? '';
    const impactRuns = /const changeImpactRuns = ([^;]+);/u.exec(html)?.[1] ?? '';
    expect(overviewRuns).not.toContain(marker);
    expect(impactRuns).toContain(marker);
    expect(html).not.toContain('DUPLICATE_IMPACT_SENTINEL');
    expect(html).not.toContain('"impactStatus":"available"');
  });

  it('keeps twenty near-megabyte raw impact sessions out of the final artifact', () => {
    const sessions = Array.from({ length: 20 }, (_, index) =>
      session(`session-${String(index)}`, {
        ...impact(`run-${String(index)}`, 'src/change.ts', 'src.changed'),
        duplicateBlob: 'x'.repeat(900_000),
      }),
    );

    const html = generateDashboardHtml({ sessions, graphCatalog: catalog() });

    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(5_000_000);
    expect(html).not.toContain('duplicateBlob');
  });

  it('enforces the model byte ceiling after script-context escaping expands evidence', () => {
    const graphCatalog = catalog();
    const graphSession = session(
      'session-escape-bound',
      impact('escape-bound', 'src/change.ts', 'src.changed'),
    );
    const baseBrief = brief('escape-bound', 'src/change.ts');
    const template = baseBrief.topRisks[0];
    if (!template) throw new Error('Review brief fixture requires one risk.');
    const escapeHeavyBrief: ReviewBrief = {
      ...baseBrief,
      topRisks: Array.from({ length: 15 }, (_, index) => ({
        ...template,
        ruleId: `escape-heavy-${String(index)}`,
        message: '<'.repeat(100_000),
      })),
    };
    const auditRun = run('RUN_escape_bound', graphSession.id, escapeHeavyBrief, 'escape bound');

    const html = generateDashboardHtml({
      sessions: [graphSession],
      runs: [auditRun],
      graphCatalog,
    });
    const embedded = /const changeImpactRuns = ([\s\S]*?);\nconst changeImpactOmittedRuns/u.exec(
      html,
    )?.[1];

    expect(embedded).toBeDefined();
    expect(Buffer.byteLength(embedded ?? '', 'utf8')).toBeLessThanOrEqual(
      MAX_CHANGE_IMPACT_MODELS_BYTES,
    );
    expect(embedded).toMatch(/"risks":[1-9]\d*/u);
  });
});
