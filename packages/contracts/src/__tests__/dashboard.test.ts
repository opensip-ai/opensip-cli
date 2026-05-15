import { describe, expect, it } from 'vitest';

import { generateDashboardHtml } from '../persistence/dashboard/generator.js';

import type { CheckCatalogEntry, RecipeCatalogEntry, StoredSession } from '../persistence/store.js';

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'sess-1',
    tool: 'fit',
    timestamp: new Date().toISOString(),
    cwd: '/proj',
    score: 92,
    passed: true,
    summary: { total: 10, passed: 9, failed: 1, errors: 0, warnings: 0 },
    checks: [],
    durationMs: 100,
    ...overrides,
  };
}

const checkCatalog: CheckCatalogEntry[] = [
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

const recipeCatalog: RecipeCatalogEntry[] = [
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

describe('generateDashboardHtml', () => {
  it('produces a complete HTML5 document', () => {
    const html = generateDashboardHtml([makeSession()]);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
  });

  it('inlines the latest session score in the document title', () => {
    const html = generateDashboardHtml([makeSession({ score: 85 })]);
    expect(html).toContain('Pass Rate: 85%');
  });

  it('omits the score from the title when there are no sessions', () => {
    const html = generateDashboardHtml([]);
    expect(html).toMatch(/<title>OpenSIP Tools<\/title>/);
  });

  it('inlines session, check catalog, and recipe catalog as JS data', () => {
    const html = generateDashboardHtml(
      [makeSession({ id: 'special-session-id' })],
      checkCatalog,
      recipeCatalog,
    );
    expect(html).toContain('special-session-id');
    expect(html).toContain('no-console-log');
    expect(html).toContain('default');
  });

  it('escapes < and > in inlined JSON to prevent script injection', () => {
    // A session whose cwd contains a fake </script> tag must not break out
    const evil = makeSession({ cwd: '</script><script>alert(1)</script>' });
    const html = generateDashboardHtml([evil]);
    expect(html).not.toMatch(/<\/script>\s*<script>alert\(1\)/);
    expect(html).toContain(String.raw`</script>`);
  });

  it('renders all three tab panels (overview, fitness, simulation)', () => {
    const html = generateDashboardHtml([]);
    expect(html).toContain('id="panel-overview"');
    expect(html).toContain('id="panel-fitness"');
    expect(html).toContain('id="panel-simulation"');
  });

  it('includes inline CSS', () => {
    const html = generateDashboardHtml([]);
    expect(html).toMatch(/<style>[\s\S]+?<\/style>/);
  });

  it('partitions sessions into fit vs sim arrays in the page script', () => {
    const html = generateDashboardHtml([
      makeSession({ id: 'fit-1', tool: 'fit' }),
      makeSession({ id: 'sim-1', tool: 'sim' }),
    ]);
    expect(html).toContain("sessions.filter(s => s.tool === 'fit')");
    expect(html).toContain("sessions.filter(s => s.tool === 'sim')");
  });
});
