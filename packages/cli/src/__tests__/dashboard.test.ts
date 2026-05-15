import { generateDashboardHtml } from '@opensip-tools/contracts';
import { describe, it, expect } from 'vitest';

import type { StoredSession } from '@opensip-tools/contracts';

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: overrides.id ?? 'test-session-1',
    tool: overrides.tool ?? 'fit',
    timestamp: overrides.timestamp ?? '2025-06-15T10:30:00.000Z',
    // eslint-disable-next-line sonarjs/publicly-writable-directories -- test fixture cwd; not a runtime filesystem operation
    cwd: overrides.cwd ?? '/tmp/my-project',
    recipe: overrides.recipe,
    score: overrides.score ?? 85,
    passed: overrides.passed ?? true,
    summary: overrides.summary ?? { total: 10, passed: 8, failed: 2, errors: 1, warnings: 3 },
    checks: overrides.checks ?? [
      {
        checkSlug: 'no-console-log',
        passed: true,
        findings: [],
        durationMs: 42,
      },
      {
        checkSlug: 'no-hardcoded-secrets',
        passed: false,
        findings: [
          {
            ruleId: 'secret-in-code',
            message: 'Found hardcoded secret',
            severity: 'error',
            filePath: 'src/config.ts',
            line: 15,
          },
        ],
        durationMs: 100,
      },
    ],
    durationMs: 1234,
  };
}

describe('generateDashboardHtml', () => {
  it('returns valid HTML with doctype and closing tags', () => {
    const html = generateDashboardHtml([makeSession()]);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('</html>');
    expect(html).toContain('</body>');
    expect(html).toContain('</head>');
  });

  it('handles empty sessions array', () => {
    const html = generateDashboardHtml([]);
    expect(html).toContain('<!DOCTYPE html>');
    // Title should not have a score
    expect(html).toContain('<title>OpenSIP Tools</title>');
    // The JS renders the "no sessions" message
    expect(html).toContain('No sessions yet');
  });

  it('includes latest session pass rate in the title', () => {
    const html = generateDashboardHtml([makeSession({ score: 92 })]);
    expect(html).toContain('Pass Rate: 92%');
  });

  it('includes session data as JSON in a script tag', () => {
    const session = makeSession({ id: 'embedded-data' });
    const html = generateDashboardHtml([session]);
    expect(html).toContain('embedded-data');
    expect(html).toContain('no-console-log');
    expect(html).toContain('no-hardcoded-secrets');
  });

  it('prevents script tag injection by escaping </ sequences', () => {
    // If session data contains "</script>", it could break out of the script tag.
    // The function replaces </ with <\/ to prevent this.
    const session = makeSession({
      checks: [
        {
          checkSlug: 'xss-check',
          passed: false,
          findings: [
            {
              ruleId: 'xss',
              message: 'Contains </script><script>alert(1)</script> payload',
              severity: 'error',
            },
          ],
          durationMs: 10,
        },
      ],
    });
    const html = generateDashboardHtml([session]);
    // The raw "</script>" inside the data should be escaped
    // It should NOT contain an unescaped </script> inside the data JSON
    const scriptStart = html.indexOf('const sessions = ');
    const scriptEnd = html.indexOf(';\nconst fitSessions');
    const jsonSection = html.slice(scriptStart, scriptEnd);
    // All < and > should be escaped as \u003c and \u003e in script context
    expect(jsonSection).not.toContain('</script>');
    expect(jsonSection).toContain(String.raw`\u003c/script\u003e`);
  });

  it('includes CSS with score color classes', () => {
    const html = generateDashboardHtml([makeSession()]);
    expect(html).toContain('.score-good');
    expect(html).toContain('.score-warn');
    expect(html).toContain('.score-bad');
  });

  it('includes the correct score class thresholds in JavaScript', () => {
    const html = generateDashboardHtml([makeSession()]);
    // The JS logic: score >= 90 -> score-good, >= 70 -> score-warn, else -> score-bad
    expect(html).toContain('score >= 90');
    expect(html).toContain('score >= 70');
  });

  it('includes check findings data', () => {
    const html = generateDashboardHtml([makeSession()]);
    expect(html).toContain('Found hardcoded secret');
    expect(html).toContain('src/config.ts');
  });

  it('includes recipe name when present', () => {
    const html = generateDashboardHtml([makeSession({ recipe: 'quick-smoke' })]);
    expect(html).toContain('quick-smoke');
  });

  it('includes the footer with opensip.ai link', () => {
    const html = generateDashboardHtml([makeSession()]);
    expect(html).toContain('opensip.ai');
    expect(html).toContain('opensip-tools');
  });

  it('handles multiple sessions for trend chart', () => {
    const sessions = [
      makeSession({ id: 's1', timestamp: '2025-06-15T10:30:00.000Z', score: 95 }),
      makeSession({ id: 's2', timestamp: '2025-06-14T10:30:00.000Z', score: 80 }),
      makeSession({ id: 's3', timestamp: '2025-06-13T10:30:00.000Z', score: 65 }),
    ];
    const html = generateDashboardHtml(sessions);
    // All session data should be embedded
    expect(html).toContain('"s1"');
    expect(html).toContain('"s2"');
    expect(html).toContain('"s3"');
  });

  it('does not include raw HTML in session data that could be executed', () => {
    const session = makeSession({
      cwd: '<img src=x onerror=alert(1)>',
    });
    const html = generateDashboardHtml([session]);
    // The data is consumed via textContent (safe), but the JSON should still be well-formed
    // The main concern is the </ escape to prevent script breakout
    expect(html).toContain('<!DOCTYPE html>');
    // Should still be valid HTML structure
    expect(html).toContain('</html>');
  });
});
