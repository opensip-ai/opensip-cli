/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Catch-all "External Tools" tab — full-render-path regression coverage for the
 * two external-adapter dashboard defects.
 *
 * Adapter scans (gitleaks / osv-scanner / trivy) persist sessions whose `tool`
 * is NOT one of the four registered tool tabs (fit / sim / graph / yagni). Their
 * worker-forked runtimes are never loaded in-host, so they structurally cannot
 * register a `defineToolTab` tab. Before the host-owned catch-all tab:
 *
 *   Defect #3 — the grouped `payload.checks[]` detail (rule + filePath + masked
 *   secret preview) rendered NOWHERE: no per-tool bucket matched an adapter tool,
 *   so only the Overview aggregate count surfaced.
 *
 *   Defect #2 — clicking an adapter row in Overview deactivated every tab/panel
 *   (including #panel-overview) and activated nothing → the whole report blanked.
 *
 * These tests exercise the FULL render path (generateDashboardHtml → boot the
 * emitted <script> in jsdom → renderExternalTab → renderSessionTable →
 * renderSessionDetail), NOT renderSessionDetail in isolation, so the routing gap
 * that was invisible to unit tests is now load-bearing.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { generateDashboardHtml } from '../generator.js';

import type { StoredSession } from '@opensip-cli/contracts';

/** A masked secret preview (redacted at ingest) — never a raw credential. */
const MASKED_PREVIEW = 'AKIA…';
/** A raw AWS key the renderer must NEVER surface (proves only redacted flows through). */
const RAW_SECRET = 'AKIAIOSFODNN7EXAMPLE';

/** An external-adapter (gitleaks) session carrying the grouped {summary, checks[]} payload. */
function gitleaksSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'gl1',
    tool: 'gitleaks',
    startedAt: '2026-06-15T10:30:00.000Z',
    completedAt: '2026-06-15T10:30:01.000Z',
    // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture cwd; not a runtime filesystem operation
    cwd: '/tmp/my-project',
    score: 0,
    passed: false,
    runOutcome: 'failed',
    durationMs: 900,
    payload: {
      __version: 1,
      summary: { total: 1, passed: 0, failed: 1, errors: 1, warnings: 0 },
      checks: [
        {
          checkSlug: 'aws-access-key',
          passed: false,
          violationCount: 1,
          durationMs: 0,
          findings: [
            {
              ruleId: 'aws-access-key',
              // Redacted at ingest — the message carries only the masked preview.
              message: 'AWS access key detected: ' + MASKED_PREVIEW,
              severity: 'error',
              filePath: 'src/config.ts',
              line: 12,
              suggestion: 'Rotate the credential and remove it from source.',
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

/** A plain fitness session (registered tool) used to assert per-tool tabs are unchanged. */
function fitSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'fit1',
    tool: 'fit',
    startedAt: '2026-06-15T11:00:00.000Z',
    completedAt: '2026-06-15T11:00:01.000Z',
    // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture cwd
    cwd: '/tmp/my-project',
    score: 100,
    passed: true,
    durationMs: 1000,
    payload: {
      summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 },
      checks: [{ checkSlug: 'no-console-log', passed: true, durationMs: 5, findings: [] }],
    },
    ...overrides,
  };
}

/**
 * Render the full report HTML into the jsdom document and evaluate its inlined
 * <script> bodies in one sandbox — the same boot the live end-to-end validation
 * test uses. Modelled on that test's bootDashboard so the assertions run through
 * the real render block (`renderOverview(); …; renderExternalTab();`).
 */
function bootReport(sessions: StoredSession[]): void {
  const html = generateDashboardHtml({ sessions });
  document.documentElement.innerHTML = html
    .replace(/^[\s\S]*?<html[^>]*>/i, '')
    .replace(/<\/html>[\s\S]*$/i, '');
  // eslint-disable-next-line unicorn/prefer-spread -- NodeListOf spread needs lib.dom.iterable.
  const scripts = Array.from(document.querySelectorAll('script'));
  let combined = '';
  for (const s of scripts) {
    const type = s.getAttribute('type');
    if (type && type !== 'text/javascript' && type !== '') continue;
    const src = s.textContent ?? '';
    if (src.length === 0) continue;
    combined += '\n' + src;
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own emitted HTML.
  new Function(combined).call(globalThis);
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.innerHTML = '';
});

describe('External Tools catch-all tab (Defect #3 — adapter findings render)', () => {
  it('emits an External Tools tab + panel and renders the adapter finding through the full path', () => {
    bootReport([gitleaksSession()]);

    // The host-owned catch-all tab button + panel exist.
    const tab = document.querySelector('.tab[data-tab="external"]');
    expect(tab).not.toBeNull();
    expect(tab!.textContent).toContain('External Tools');
    const panel = document.querySelector<HTMLElement>('#panel-external');
    expect(panel).not.toBeNull();

    // The grouped payload.checks[] detail is REACHABLE in the panel (the rule and
    // the file render through renderExternalTab → renderSessionTable →
    // renderSessionDetail, which falls back to a "Check" column for the unknown
    // tool). Auto-shown latest detail means no click is needed.
    const text = panel!.textContent ?? '';
    expect(text).toContain('aws-access-key');
    expect(text).toContain('src/config.ts');
  });

  it('shows only the masked secret preview, never a raw credential', () => {
    bootReport([gitleaksSession()]);
    const panel = document.querySelector<HTMLElement>('#panel-external')!;
    const text = panel.textContent ?? '';
    expect(text).toContain(MASKED_PREVIEW);
    expect(text).not.toContain(RAW_SECRET);
  });

  it('does NOT emit an External Tools tab when every session belongs to a registered tab', () => {
    bootReport([fitSession()]);
    // A fit-only repo never shows an empty External Tools tab/panel.
    expect(document.querySelector('.tab[data-tab="external"]')).toBeNull();
    expect(document.querySelector('#panel-external')).toBeNull();
    // The fitness tab is unchanged.
    expect(document.querySelector('.tab[data-tab="fitness"]')).not.toBeNull();
  });
});

describe('Overview row-click routing (Defect #2 — adapter row must not blank the report)', () => {
  it('routes an adapter session row to the External Tools tab without blanking the report', () => {
    bootReport([gitleaksSession()]);

    // Overview starts active. Click the (only) adapter row in Recent Activity.
    expect(document.querySelector('#panel-overview')!.classList.contains('active')).toBe(true);
    const row = document.querySelector<HTMLElement>('#panel-overview tbody tr.clickable');
    expect(row).not.toBeNull();
    row!.click();

    // The row routed to the catch-all tab — NOT a no-op blank. Exactly one panel
    // is active (the External Tools panel), and Overview was deactivated.
    const activePanels = document.querySelectorAll('.tab-panel.active');
    expect(activePanels.length).toBe(1);
    expect(activePanels[0].id).toBe('panel-external');
    expect(document.querySelector('.tab[data-tab="external"]')!.classList.contains('active')).toBe(
      true,
    );
    expect(document.querySelector('#panel-overview')!.classList.contains('active')).toBe(false);
  });

  it('still routes a registered-tool (fit) row to its own tab', () => {
    bootReport([fitSession(), gitleaksSession()]);
    // Click the fit row (find it by its FIT badge in Recent Activity).
    const rows = [...document.querySelectorAll<HTMLElement>('#panel-overview tbody tr.clickable')];
    const fitRow = rows.find((r) => r.textContent?.includes('FIT'));
    expect(fitRow).not.toBeUndefined();
    fitRow!.click();
    expect(document.querySelector('.tab[data-tab="fitness"]')!.classList.contains('active')).toBe(
      true,
    );
    expect(document.querySelector('#panel-fitness')!.classList.contains('active')).toBe(true);
  });
});
