/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 */

import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { generateDashboardHtml } from '../generator.js';

import type { DashboardRun } from '../generator.js';
import type {
  GraphCatalog,
  ReviewBrief,
  StoredRunStep,
  StoredSession,
} from '@opensip-cli/contracts';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const graphCatalog: GraphCatalog = {
  version: '2.0',
  tool: 'graph',
  language: 'typescript',
  builtAt: '2026-07-12T00:00:00.000Z',
  cacheKey: 'change-impact-catalog-key',
  filesFingerprint: '1\nsrc/change.ts|1|1',
  resolutionMode: 'exact',
  functions: {
    changed: [
      {
        bodyHash: 'body-changed',
        simpleName: 'changed',
        qualifiedName: 'src.changed',
        filePath: 'src/change.ts',
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
    twin: [
      {
        bodyHash: 'body-changed',
        simpleName: 'twin',
        qualifiedName: 'src.twin',
        filePath: 'src/twin.ts',
        line: 3,
        column: 0,
        endLine: 4,
        kind: 'function-declaration',
        params: [],
        returnType: null,
        enclosingClass: null,
        decorators: [],
        visibility: 'module-local',
        inTestFile: false,
        definedInGenerated: false,
        calls: [],
      },
    ],
  },
};

function reviewBrief(message = 'Review the changed function.'): ReviewBrief {
  const risk = {
    source: 'fit',
    ruleId: 'fixture-risk',
    message,
    severity: 'high' as const,
    file: 'src/change.ts',
    line: 1,
    isNew: true,
    signalRef: {
      tool: 'fit',
      suiteRunId: 'suite-1',
      stepIndex: 0,
      signalIndex: 0,
    },
  };
  const correlationRef = {
    source: 'fit',
    ruleId: 'fixture-risk',
    file: 'src/change.ts',
    line: 1,
    signalRef: risk.signalRef,
  };
  return {
    version: 1,
    suite: 'audit',
    suiteRunId: 'suite-1',
    verdict: 'warn',
    changedFiles: 1,
    topRisks: [risk],
    newFindings: [risk],
    baselineDelta: { available: true, added: 1, removed: 0, unchanged: 0 },
    degraded: [],
    recommendedActions: [
      {
        priority: 'high',
        message: 'Inspect the caller.',
        command: 'opensip audit --json',
      },
    ],
    correlatedRisks: [
      {
        id: 'corr-fixture',
        title: 'Related fixture risks',
        severity: 'high',
        isNew: true,
        primary: correlationRef,
        members: [
          correlationRef,
          {
            source: 'graph',
            ruleId: 'impact',
            file: 'src/change.ts',
            line: 1,
            signalRef: { ...risk.signalRef, tool: 'graph', stepIndex: 1 },
          },
        ],
        entities: [],
        reasons: [
          {
            kind: 'same-file',
            key: { kind: 'file', value: 'src/change.ts', confidence: 'high' },
            confidence: 'high',
            message: 'Risks share a file.',
          },
        ],
      },
    ],
  };
}

function graphStep(runId: string, sessionId: string): StoredRunStep {
  return {
    id: `step-${runId}`,
    runId,
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
  };
}

function auditRun(
  id: string,
  completedAt: string,
  sessionId: string,
  brief = reviewBrief(),
): DashboardRun {
  return {
    id,
    name: 'audit',
    source: 'built-in-suite',
    cwd: '/repo',
    startedAt: '2026-07-12T00:00:00.000Z',
    completedAt,
    durationMs: 100,
    exitCode: 0,
    aggregate: {
      steps: 3,
      passed: 3,
      failed: 0,
      faulted: 0,
      errors: 0,
      warnings: 1,
    },
    scope: { mode: 'changed', source: 'explicit', changedFiles: 1 },
    reviewBrief: brief,
    steps: [graphStep(id, sessionId)],
  };
}

function impactSession(id: string, overrides: Record<string, unknown> = {}): StoredSession {
  return {
    id,
    tool: 'graph',
    cwd: '/repo',
    startedAt: '2026-07-12T00:00:00.000Z',
    completedAt: '2026-07-12T00:00:00.100Z',
    durationMs: 100,
    score: 100,
    passed: true,
    payload: {
      __version: 1,
      impactStatus: 'available',
      impact: {
        catalog: {
          builtAt: graphCatalog.builtAt,
          language: graphCatalog.language,
          filesFingerprint: digest(graphCatalog.filesFingerprint ?? ''),
          resolutionMode: graphCatalog.resolutionMode,
          cacheKeyDigest: digest(graphCatalog.cacheKey ?? ''),
        },
        basis: { type: 'files', warningCodes: [] },
        changedFiles: ['src/change.ts'],
        changedFunctions: [
          {
            qualifiedName: 'src.changed',
            filePath: 'src/change.ts',
            line: 1,
            package: 'src',
            reason: 'changed',
          },
        ],
        impactedFunctions: [],
        impactedFiles: [],
        impactedPackages: [],
        trust: {
          coverage: 'full',
          fallback: 'targeted',
          fullyVerified: true,
          uncertainties: [],
        },
        recommendedCommands: ['opensip fit --changed'],
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
        ...overrides,
      },
    },
  };
}

function bootReport(input: Parameters<typeof generateDashboardHtml>[0]): string {
  const html = generateDashboardHtml(input);
  document.documentElement.innerHTML = html
    .replace(/^[\s\S]*?<html[^>]*>/iu, '')
    .replace(/<\/html>[\s\S]*$/iu, '');
  const scripts = [...document.querySelectorAll('script')];
  let combined = '';
  for (const script of scripts) {
    const type = script.getAttribute('type');
    if (type && type !== 'text/javascript') continue;
    if (script.textContent) combined += `\n${script.textContent}`;
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- trusted generated report under test.
  new Function(combined).call(globalThis);
  return html;
}

beforeEach(() => {
  document.documentElement.innerHTML = '';
  globalThis.history.replaceState(null, '', '/latest.html');
  delete (globalThis as { __changeImpactInjected?: boolean }).__changeImpactInjected;
});

describe('Change Impact generated report', () => {
  it('keeps the surface discoverable with an accessible empty state', () => {
    bootReport({ sessions: [] });

    const tab = document.querySelector<HTMLButtonElement>('[data-tab="change-impact"]');
    const panel = document.querySelector<HTMLElement>('#panel-change-impact');
    expect(tab?.id).toBe('tab-change-impact');
    expect(tab?.getAttribute('aria-controls')).toBe('panel-change-impact');
    expect(panel?.getAttribute('aria-labelledby')).toBe('tab-change-impact');
    expect(panel?.textContent).toContain('opensip audit --open');
    expect(document.querySelector('#panel-overview')?.classList.contains('active')).toBe(true);
  });

  it('selects an exact stored run and renders trust, risks, members, commands, and entities', () => {
    const run1 = auditRun('RUN_first', '2026-07-12T00:00:01.000Z', 'session-1');
    const run2 = auditRun('RUN_second', '2026-07-12T00:00:02.000Z', 'session-2');
    bootReport({
      sessions: [impactSession('session-1'), impactSession('session-2')],
      runs: [run1, run2],
      graphCatalog,
      selection: { view: 'change-impact', runId: 'RUN_first' },
    });

    const panel = document.querySelector<HTMLElement>('#panel-change-impact');
    const select = panel?.querySelector<HTMLSelectElement>('#change-impact-run-select');
    expect(select?.value).toBe('RUN_first');
    expect(panel?.textContent).toContain('Fully verified for the stored scope');
    expect(panel?.textContent).toContain('Member: graph impact');
    expect(panel?.textContent).toContain('opensip fit --changed');
    expect(panel?.textContent).toContain('src.changed');
    expect(panel?.querySelector('button.fc-action')?.textContent).toBe('Open');
    expect(globalThis.location.hash).toBe('#change-impact/RUN_first');
    expect(panel?.hidden).toBe(false);
    expect(document.querySelector('#panel-overview')?.hasAttribute('hidden')).toBe(true);

    panel?.querySelector<HTMLButtonElement>('button.fc-action')?.click();
    expect(document.querySelector('#panel-code-paths')?.classList.contains('active')).toBe(true);
    expect(document.querySelector('.function-card .fc-loc')?.textContent).toBe('src/change.ts:1');
    expect(globalThis.location.hash).toMatch(/^#code-paths\//u);
  });

  it('consumes valid hash changes, rejects prefix lookalikes, and clears the hash on tab exit', () => {
    const run1 = auditRun('RUN_first', '2026-07-12T00:00:01.000Z', 'session-1');
    const run2 = auditRun('RUN_second', '2026-07-12T00:00:02.000Z', 'session-2');
    globalThis.history.replaceState(null, '', '/latest.html#change-impact/RUN_second');
    bootReport({
      sessions: [impactSession('session-1'), impactSession('session-2')],
      runs: [run1, run2],
      graphCatalog,
      selection: { view: 'change-impact', runId: 'RUN_first' },
    });
    expect(document.querySelector<HTMLSelectElement>('#change-impact-run-select')?.value).toBe(
      'RUN_second',
    );

    globalThis.history.replaceState(null, '', '/latest.html#change-impact/RUN_first');
    globalThis.dispatchEvent(new Event('hashchange'));
    expect(document.querySelector<HTMLSelectElement>('#change-impact-run-select')?.value).toBe(
      'RUN_first',
    );

    document.querySelector<HTMLButtonElement>('[data-tab="overview"]')?.click();
    expect(globalThis.location.hash).toBe('');
    expect(document.querySelector('[data-tab="overview"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );

    globalThis.history.replaceState(null, '', '/latest.html#change-impactX');
    document.querySelector<HTMLButtonElement>('[data-tab="overview"]')?.click();
    expect(document.querySelector('#panel-overview')?.classList.contains('active')).toBe(true);
  });

  it('keeps an explicit Code Paths deep link authoritative over embedded selection on boot', () => {
    const run = auditRun('RUN_first', '2026-07-12T00:00:01.000Z', 'session-1');
    globalThis.history.replaceState(null, '', '/latest.html#code-paths/distribution');

    bootReport({
      sessions: [impactSession('session-1')],
      runs: [run],
      graphCatalog,
      selection: { view: 'change-impact', runId: 'RUN_first' },
    });

    expect(globalThis.location.hash).toBe('#code-paths/distribution');
    expect(document.querySelector('#panel-code-paths')?.classList.contains('active')).toBe(true);
    expect(document.querySelector('#panel-change-impact')?.classList.contains('active')).toBe(
      false,
    );
  });

  it('keeps hostile stored text inert in the inline script and DOM', () => {
    const marker = '</script><script>globalThis.__changeImpactInjected=true</script>';
    const run = auditRun(
      'RUN_hostile',
      '2026-07-12T00:00:01.000Z',
      'session-hostile',
      reviewBrief(marker),
    );
    const html = bootReport({
      sessions: [impactSession('session-hostile')],
      runs: [run],
      graphCatalog,
      selection: { view: 'change-impact', runId: 'RUN_hostile' },
    });

    expect(html).not.toContain(marker);
    expect(
      (globalThis as { __changeImpactInjected?: boolean }).__changeImpactInjected,
    ).toBeUndefined();
    expect(document.querySelector('#panel-change-impact')?.textContent).toContain(marker);
  });

  it('renders unavailable evidence conservatively without falling back to another session', () => {
    const run = auditRun('RUN_legacy', '2026-07-12T00:00:01.000Z', 'missing-session');
    bootReport({
      sessions: [impactSession('unlinked-newer')],
      runs: [run],
      graphCatalog,
      selection: { view: 'change-impact', runId: 'RUN_legacy' },
    });

    const text = document.querySelector('#panel-change-impact')?.textContent ?? '';
    expect(text).toContain('authoritative graph session link is unavailable');
    expect(text).not.toContain('Verified zero stored impact');
  });
});
