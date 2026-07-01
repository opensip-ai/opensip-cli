import { describe, expect, it } from 'vitest';

import { generateDashboardHtml } from '../generator.js';

import type { DeclaredInputs, StoredSession } from '@opensip-cli/contracts';

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'sess-1',
    tool: 'fit',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    cwd: '/proj',
    score: 92,
    passed: true,
    durationMs: 100,
    // Tool-owned opaque detail; contracts no longer carries summary/checks.
    payload: { summary: { total: 10, passed: 9, failed: 1, errors: 0, warnings: 0 }, checks: [] },
    ...overrides,
  };
}

// Catalog entry shapes are fitness-owned (L1); the dashboard consumes
// them structurally, so the test supplies plain objects.
const checkCatalog = [
  {
    slug: 'no-console-log',
    name: 'No console.log',
    icon: '🚫',
    description: 'Forbids console.log in production',
    tags: ['quality'],
    confidence: 'high',
    source: 'built-in',
  },
];

const recipeCatalog = [
  {
    name: 'default',
    displayName: 'Default',
    description: 'All checks',
    tags: [],
    selectorType: 'all',
    mode: 'parallel',
    timeout: 30_000,
  },
];

const declaredInputs: DeclaredInputs = {
  cliVersion: '0.1.19',
  nodeVersion: '24.16.0',
  packageManager: 'pnpm@10.0.0+sha512.deadbeef',
  platform: 'darwin/arm64',
  tool: 'report',
  engineVersion: 'unknown',
};

describe('generateDashboardHtml', () => {
  it('produces a complete HTML5 document', () => {
    const html = generateDashboardHtml({ sessions: [makeSession()] });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });

  it('inlines the latest session score in the document title', () => {
    const html = generateDashboardHtml({ sessions: [makeSession({ score: 85 })] });
    expect(html).toContain('Pass Rate: 85%');
  });

  it('omits the score from the title when there are no sessions', () => {
    const html = generateDashboardHtml({ sessions: [] });
    expect(html).toMatch(/<title>OpenSIP CLI<\/title>/);
  });

  it('inlines session, check catalog, and recipe catalog as JS data', () => {
    const html = generateDashboardHtml({
      sessions: [makeSession({ id: 'special-session-id' })],
      checkCatalog,
      recipeCatalog,
    });
    expect(html).toContain('special-session-id');
    expect(html).toContain('no-console-log');
    expect(html).toContain('default');
  });

  it('keeps declared input metadata behind the header report details disclosure', () => {
    const html = generateDashboardHtml({ sessions: [makeSession()], declaredInputs });
    const headerStart = html.indexOf('<div class="header">');
    const detailsStart = html.indexOf('<details class="report-details">');
    const tabStart = html.indexOf('<div class="tab-bar"');

    expect(headerStart).toBeGreaterThan(-1);
    expect(detailsStart).toBeGreaterThan(headerStart);
    expect(detailsStart).toBeLessThan(tabStart);
    expect(html).toContain('<span class="report-details-label">Report details</span>');
    expect(html).toContain('<div class="report-details-title">Run environment</div>');
    expect(html).toContain('<dt>Package manager</dt><dd>pnpm@10.0.0+sha512.deadbeef</dd>');
    expect(html).not.toContain('<div class="card" style="margin:16px 24px 0;padding:12px 16px">');
  });

  it('escapes < and > in inlined JSON to prevent script injection', () => {
    // A session whose cwd contains a fake </script> tag must not break out
    const evil = makeSession({ cwd: '</script><script>alert(1)</script>' });
    const html = generateDashboardHtml({ sessions: [evil] });
    expect(html).not.toMatch(/<\/script>\s*<script>alert\(1\)/);
    expect(html).toContain(String.raw`</script>`);
  });

  // Regression for the 2026-05-25 audit fix on serializeOptionalBlob.
  // The 'literal' arm (used for editorProtocol) previously called
  // JSON.stringify without escapeForScriptContext; JSON.stringify does not
  // escape `<`, so a caller-controlled editorProtocol containing the literal
  // sequence `</script>` would close the inline <script> block. After the
  // fix, both arms apply the same escape — `<` becomes `<`.
  it('escapes </script> in editorProtocol literal so it cannot close the inline script block', () => {
    const html = generateDashboardHtml({
      sessions: [],
      editorProtocol: '</script><img src=x onerror=alert(1)>',
    });
    // The escaped form must be present; the raw form must NOT appear inside
    // the EDITOR_PROTOCOL constant assignment.
    const literalLine = html
      .split('\n')
      .find((line) => line.startsWith('const EDITOR_PROTOCOL = '));
    expect(literalLine).toBeDefined();
    expect(literalLine ?? '').not.toContain('</script>');
    // The escape function rewrites `<` to the JS Unicode escape `<`,
    // which the HTML tokenizer does not match against `</script>`.
    // (`String.raw`<`` is the 1-char `<` because the JS lexer processes
    // Unicode escapes before String.raw sees them — a backslash literal
    // is required for the 6-character on-disk sequence.)
    expect(literalLine ?? '').toContain('\\u003c');
  });

  // Regression for the 2026-05-25 audit fix on the <title> interpolation:
  // session.score is typed `number` but originates from a SQLite column; a
  // corrupted row carrying a non-numeric value would otherwise interpolate
  // directly into the page title. coerceScoreForTitle falls back to 0 for
  // anything non-finite.
  it('renders score 0 in <title> when the session score is non-finite', () => {
    const bad = makeSession({ score: Number.NaN });
    const html = generateDashboardHtml({ sessions: [bad] });
    expect(html).toMatch(/<title>OpenSIP CLI — Pass Rate: 0%<\/title>/);
  });

  it('renders all three tab panels (overview, fitness, simulation)', () => {
    const html = generateDashboardHtml({ sessions: [] });
    expect(html).toContain('id="panel-overview"');
    expect(html).toContain('id="panel-fitness"');
    expect(html).toContain('id="panel-simulation"');
  });

  it('includes inline CSS', () => {
    const html = generateDashboardHtml({ sessions: [] });
    expect(html).toMatch(/<style>[\s\S]+?<\/style>/);
  });

  it('partitions sessions into fit vs sim arrays in the page script', () => {
    const html = generateDashboardHtml({
      sessions: [
        makeSession({ id: 'fit-1', tool: 'fit' }),
        makeSession({ id: 'sim-1', tool: 'sim' }),
      ],
    });
    expect(html).toContain("sessions.filter(s => s.tool === 'fit')");
    expect(html).toContain("sessions.filter(s => s.tool === 'sim')");
  });
});
