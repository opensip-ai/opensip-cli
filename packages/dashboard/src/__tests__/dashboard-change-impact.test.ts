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

function sessionWithPayload(id: string, payload: unknown): StoredSession {
  return { ...impactSession(id), payload };
}

function factValue(panel: ParentNode, label: string): string | undefined {
  const term = [...panel.querySelectorAll('dt')].find(
    (candidate) => candidate.textContent === label,
  );
  return term?.nextElementSibling?.textContent ?? undefined;
}

function expandedBrief(riskCount: number, messageLength = 32): ReviewBrief {
  const base = reviewBrief();
  const template = base.topRisks[0];
  if (!template) throw new Error('review brief fixture requires one risk');
  return {
    ...base,
    topRisks: Array.from({ length: riskCount }, (_, index) => ({
      ...template,
      ruleId: `fixture-risk-${String(index)}`,
      message: `${String(index)}:${'x'.repeat(messageLength)}`,
    })),
    newFindings: [],
  };
}

function bootReport(
  input: Parameters<typeof generateDashboardHtml>[0],
  beforeExecute?: () => () => void,
  transformScript: (source: string) => string = (source) => source,
): string {
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
  const cleanup = beforeExecute?.();
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- trusted generated report under test.
    new Function(transformScript(combined)).call(globalThis);
  } finally {
    cleanup?.();
  }
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
    expect(document.querySelector('#tab-bar')?.getAttribute('role')).toBe('tablist');
    expect(tab?.getAttribute('role')).toBe('tab');
    expect(tab?.id).toBe('tab-change-impact');
    expect(tab?.getAttribute('aria-controls')).toBe('panel-change-impact');
    expect(tab?.getAttribute('aria-selected')).toBe('false');
    expect(tab?.tabIndex).toBe(-1);
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(panel?.getAttribute('aria-labelledby')).toBe('tab-change-impact');
    expect(panel?.textContent).toContain('opensip audit --open');
    expect(document.querySelector('#panel-overview')?.classList.contains('active')).toBe(true);
  });

  it('discloses stored audit runs when the report budget retains no view models', () => {
    bootReport({ sessions: [] }, undefined, (source) =>
      source.replace('const changeImpactOmittedRuns = 0;', 'const changeImpactOmittedRuns = 2;'),
    );

    const panel = document.querySelector<HTMLElement>('#panel-change-impact');
    expect(panel?.textContent).toContain('Stored audit run details are unavailable.');
    expect(panel?.textContent).toContain('2 stored audit run(s) omitted from this report.');
    expect(panel?.textContent).not.toContain('Run opensip audit --open');
  });

  it('provides roving keyboard navigation across the complete top-level tablist', () => {
    bootReport({ sessions: [] });
    document.querySelectorAll('style').forEach((style) => style.remove());

    const tabBar = document.querySelector<HTMLElement>('#tab-bar');
    const tabs = [...(tabBar?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    const overview = tabs[0];
    const changeImpact = tabs.find((tab) => tab.dataset.tab === 'change-impact');
    const last = tabs.at(-1);
    expect(tabs.length).toBeGreaterThan(2);
    expect(overview?.tabIndex).toBe(0);
    expect(tabs.slice(1).every((tab) => tab.tabIndex === -1)).toBe(true);

    overview?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(changeImpact?.getAttribute('aria-selected')).toBe('true');
    expect(changeImpact?.tabIndex).toBe(0);
    expect(document.activeElement).toBe(changeImpact);
    expect(document.querySelector('#panel-change-impact')?.hasAttribute('hidden')).toBe(false);

    changeImpact?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(last);
    expect(last?.tabIndex).toBe(0);

    last?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(overview);
    expect(overview?.getAttribute('aria-selected')).toBe('true');

    overview?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.activeElement).toBe(last);
    expect(last?.getAttribute('aria-selected')).toBe('true');
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
    expect(select?.getAttribute('aria-label')).toBe('Audit run');
    expect(select?.disabled).toBe(false);
    expect(panel?.querySelectorAll('[aria-live]').length).toBe(1);
    expect(panel?.querySelector('[aria-live="polite"]')?.textContent).toContain('RUN_first');
    expect(panel?.textContent).toContain('Fully verified for the stored scope');
    expect(panel?.textContent).toContain('Member: graph impact');
    expect(panel?.textContent).toContain('opensip fit --changed');
    expect(panel?.textContent).toContain('src.changed');
    expect(panel?.querySelector('button.fc-action')?.textContent).toBe('Open');
    expect(panel?.querySelector('button.fc-action')?.getAttribute('type')).toBe('button');
    expect(
      [...(panel?.querySelectorAll('table caption') ?? [])].map((caption) => caption.textContent),
    ).toEqual(['Changed functions']);
    expect(globalThis.location.hash).toBe('#change-impact/RUN_first');
    expect(panel?.hidden).toBe(false);
    expect(document.querySelector('#panel-overview')?.hasAttribute('hidden')).toBe(true);

    if (select) {
      select.value = 'RUN_second';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    expect(panel?.querySelector('[aria-live="polite"]')?.textContent).toContain('RUN_second');
    expect(globalThis.location.hash).toBe('#change-impact/RUN_second');

    if (select) {
      select.value = 'RUN_first';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    panel?.querySelector<HTMLButtonElement>('button.fc-action')?.click();
    expect(document.querySelector('#panel-code-paths')?.classList.contains('active')).toBe(true);
    expect(document.querySelector('.function-card .fc-loc')?.textContent).toBe('src/change.ts:1');
    expect(globalThis.location.hash).toMatch(/^#code-paths\//u);
  });

  it('renders nonzero impact with semantic tables, captions, and meaningful row controls', () => {
    const run = auditRun('RUN_nonzero', '2026-07-12T00:00:01.000Z', 'session-nonzero');
    bootReport({
      sessions: [
        impactSession('session-nonzero', {
          impactedFunctions: [
            {
              qualifiedName: 'src.changed',
              filePath: 'src/change.ts',
              line: 1,
              package: 'src',
              reason: 'caller',
            },
          ],
          impactedFiles: ['src/caller.ts'],
          impactedPackages: [{ name: 'src', functionCount: 1 }],
        }),
      ],
      runs: [run],
      graphCatalog,
      selection: { view: 'change-impact', runId: run.id },
    });

    const panel = document.querySelector<HTMLElement>('#panel-change-impact');
    expect(panel?.querySelector('h2')?.textContent).toBe('Change Impact');
    expect(panel?.querySelector('.change-impact-counts')?.textContent).toContain(
      'Impacted functions1',
    );
    expect(panel?.querySelectorAll('table.data-table')).toHaveLength(2);
    expect(
      [...(panel?.querySelectorAll('table caption') ?? [])].map((caption) => caption.textContent),
    ).toEqual(['Changed functions', 'Impacted functions']);
    expect(panel?.querySelectorAll('button.fc-action')).toHaveLength(2);
    expect(panel?.querySelector('tbody th[scope="row"]')?.textContent).toBe('src.changed');
    expect(panel?.querySelector('button.fc-action')?.getAttribute('aria-label')).toBe(
      'Open Code Paths for src.changed',
    );
    expect(panel?.textContent).toContain('src/caller.ts');
    expect(panel?.textContent).toContain('src: 1 function(s)');
  });

  it.each([
    {
      name: 'partial and truncated',
      overrides: {
        trust: {
          coverage: 'partial',
          fallback: 'targeted',
          fullyVerified: false,
          uncertainties: [
            {
              code: 'changed-file-unmatched',
              source: 'files',
              message: 'One changed file was not represented.',
              filePath: 'src/change.ts',
            },
          ],
        },
        truncated: true,
        detailTruncated: true,
        metadataOmitted: true,
      },
      expected: [
        'partial',
        'Not fully verified',
        'changed-file-unmatched',
        'Some source or display evidence was truncated or omitted',
      ],
    },
    {
      name: 'unknown coverage',
      overrides: {
        trust: {
          coverage: 'unknown',
          fallback: 'unavailable',
          fullyVerified: false,
          uncertainties: [],
        },
      },
      expected: [
        'unknown',
        'Not fully verified',
        'No stored impact found; coverage is not complete enough to claim zero risk',
      ],
    },
  ])('renders conservative $name evidence labels', ({ overrides, expected }) => {
    const run = auditRun('RUN_quality', '2026-07-12T00:00:01.000Z', 'session-quality');
    bootReport({
      sessions: [impactSession('session-quality', overrides)],
      runs: [run],
      graphCatalog,
      selection: { view: 'change-impact', runId: run.id },
    });

    const text = document.querySelector('#panel-change-impact')?.textContent ?? '';
    expected.forEach((label) => expect(text).toContain(label));
    expect(text).not.toContain('Verified zero stored impact for this scope');
  });

  it('discloses backend, report, and defensive client omissions as separate facts', () => {
    const run = auditRun(
      'RUN_omissions',
      '2026-07-12T00:00:01.000Z',
      'session-omissions',
      expandedBrief(101),
    );
    const changedFiles = Array.from(
      { length: 102 },
      (_, index) => `src/change-${String(index)}.ts`,
    );
    bootReport({
      sessions: [
        impactSession('session-omissions', {
          changedFiles,
          omitted: {
            changedFiles: 3,
            changedFunctions: 0,
            impactedFunctions: 0,
            impactedFiles: 0,
            impactedPackages: 0,
            recommendedCommands: 0,
          },
        }),
      ],
      runs: [run],
      graphCatalog,
      selection: { view: 'change-impact', runId: run.id },
    });

    const panel = document.querySelector<HTMLElement>('#panel-change-impact');
    if (!panel) throw new Error('Change Impact panel missing');
    expect(factValue(panel, 'Backend rows omitted')).toBe('3');
    expect(factValue(panel, 'Report rows omitted')).toBe('0');
    expect(Number(factValue(panel, 'Client display rows omitted'))).toBeGreaterThanOrEqual(3);
    expect(panel.textContent).toContain('3 additional row(s) omitted by the backend projection.');
    expect(panel.textContent).toContain(
      '2 additional row(s) omitted by the defensive client limit.',
    );
    expect(panel.textContent).toContain(
      '1 risk entry/entries omitted by the defensive client limit.',
    );
  });

  it('discloses report-budget omissions independently from backend and client caps', () => {
    const run = auditRun(
      'RUN_report_bound',
      '2026-07-12T00:00:01.000Z',
      'session-report-bound',
      expandedBrief(150, 18_000),
    );
    bootReport({
      sessions: [impactSession('session-report-bound')],
      runs: [run],
      graphCatalog,
      selection: { view: 'change-impact', runId: run.id },
    });

    const panel = document.querySelector<HTMLElement>('#panel-change-impact');
    if (!panel) throw new Error('Change Impact panel missing');
    expect(factValue(panel, 'Backend rows omitted')).toBe('0');
    expect(Number(factValue(panel, 'Report rows omitted'))).toBeGreaterThan(0);
    expect(panel.textContent).toMatch(/[1-9]\d* risk entry\/entries omitted by the report budget/u);
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

  it.each([
    {
      availability: 'projection degraded',
      payload: { __version: 1, impactStatus: 'omitted-overflow' },
      stepOutcome: 'passed' as const,
      expected: 'bounded report projection was omitted',
    },
    {
      availability: 'step faulted',
      payload: { __version: 1, impactStatus: 'available' },
      stepOutcome: 'faulted' as const,
      expected: 'Do not infer a clean result',
    },
    {
      availability: 'malformed',
      payload: {
        __version: 1,
        impactStatus: 'available',
        impact: { changedFiles: ['/absolute/path-is-invalid'] },
      },
      stepOutcome: 'passed' as const,
      expected: 'failed validation and was not rendered',
    },
    {
      availability: 'legacy',
      payload: { __version: 1 },
      stepOutcome: 'passed' as const,
      expected: 'predates stored Change Impact evidence',
    },
  ])(
    'renders $availability evidence without implying clean coverage',
    ({ payload, stepOutcome, expected }) => {
      const base = auditRun('RUN_state', '2026-07-12T00:00:01.000Z', 'session-state');
      const run: DashboardRun = {
        ...base,
        steps: [{ ...graphStep(base.id, 'session-state'), outcome: stepOutcome }],
      };
      bootReport({
        sessions: [sessionWithPayload('session-state', payload)],
        runs: [run],
        graphCatalog,
        selection: { view: 'change-impact', runId: run.id },
      });

      const text = document.querySelector('#panel-change-impact')?.textContent ?? '';
      expect(text).toContain(expected);
      expect(text).not.toContain('Verified zero stored impact');
    },
  );

  it('renders catalog mismatch as noninteractive explanatory text', () => {
    const run = auditRun('RUN_mismatch', '2026-07-12T00:00:01.000Z', 'session-mismatch');
    bootReport({
      sessions: [impactSession('session-mismatch')],
      runs: [run],
      graphCatalog: { ...graphCatalog, cacheKey: 'rebuilt-catalog-key' },
      selection: { view: 'change-impact', runId: run.id },
    });

    const panel = document.querySelector<HTMLElement>('#panel-change-impact');
    const unavailable = panel?.querySelector<HTMLElement>('[aria-disabled="true"]');
    expect(factValue(panel ?? document, 'Catalog qualification')).toBe('mismatched');
    expect(panel?.querySelector('button.fc-action')).toBeNull();
    expect(unavailable?.textContent).toContain('stored and current catalogs do not match');
    expect(unavailable?.tagName).toBe('SPAN');
  });

  it('renders malformed-present ReviewBrief data conservatively instead of inferring PASS', () => {
    const malformedBrief = {
      ...reviewBrief(),
      topRisks: { invalid: true },
    } as unknown as ReviewBrief;
    const run = auditRun(
      'RUN_bad_brief',
      '2026-07-12T00:00:01.000Z',
      'session-bad-brief',
      malformedBrief,
    );
    bootReport({
      sessions: [impactSession('session-bad-brief')],
      runs: [run],
      graphCatalog,
      selection: { view: 'change-impact', runId: run.id },
    });

    const panel = document.querySelector<HTMLElement>('#panel-change-impact');
    expect(panel?.querySelector('.change-impact-verdict-warn')?.textContent).toBe('WARN');
    expect(panel?.textContent).toContain('Review brief: malformed');
    expect(panel?.textContent).toContain('Treat this review as incomplete');
    expect(panel?.querySelector('.change-impact-verdict-pass')).toBeNull();
  });

  it('disables drill-down when a current-catalog tuple is ambiguous', () => {
    const run = auditRun('RUN_ambiguous', '2026-07-12T00:00:01.000Z', 'session-ambiguous');
    const ambiguousCatalog: GraphCatalog = {
      ...graphCatalog,
      functions: {
        ...graphCatalog.functions,
        duplicate: [{ ...graphCatalog.functions.changed[0], bodyHash: 'other-body' }],
      },
    };
    bootReport({
      sessions: [impactSession('session-ambiguous')],
      runs: [run],
      graphCatalog: ambiguousCatalog,
      selection: { view: 'change-impact', runId: run.id },
    });

    const panel = document.querySelector<HTMLElement>('#panel-change-impact');
    expect(panel?.querySelector('button.fc-action')).toBeNull();
    expect(panel?.textContent).toContain('identity is ambiguous');
  });

  it('isolates one section render failure and leaves other sections and tabs operational', () => {
    const run = auditRun('RUN_isolated', '2026-07-12T00:00:01.000Z', 'session-isolated');
    bootReport(
      {
        sessions: [impactSession('session-isolated')],
        runs: [run],
        graphCatalog,
        selection: { view: 'change-impact', runId: run.id },
      },
      () => {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- the fixture invokes the saved DOM method with Reflect.apply and restores it verbatim.
        const nativeAppend = Element.prototype.append;
        Element.prototype.append = function (...nodes: (Node | string)[]): void {
          const tableText = nodes
            .map((node) => (typeof node === 'string' ? node : node.textContent))
            .join('');
          if (
            this instanceof HTMLTableElement &&
            tableText.includes('Function') &&
            tableText.includes('Code Paths')
          ) {
            throw new Error('fixture entity renderer failure');
          }
          Reflect.apply(nativeAppend, this, nodes);
        };
        return () => {
          Element.prototype.append = nativeAppend;
        };
      },
    );

    const panel = document.querySelector<HTMLElement>('#panel-change-impact');
    expect(panel?.textContent).toContain(
      'Impact entities is unavailable because its stored evidence could not be rendered.',
    );
    expect(panel?.textContent).toContain('Fully verified for the stored scope');
    expect(panel?.textContent).toContain('Review risks and actions');

    document.querySelector<HTMLButtonElement>('[data-tab="overview"]')?.click();
    expect(document.querySelector('#panel-overview')?.classList.contains('active')).toBe(true);
    expect(document.querySelector('#panel-change-impact')?.hasAttribute('hidden')).toBe(true);
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
