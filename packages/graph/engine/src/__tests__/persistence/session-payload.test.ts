import { describe, expect, it } from 'vitest';

import { buildGraphSessionPayload } from '../../persistence/session-payload.js';
import { buildCliOutput } from '../../render/json.js';

/** A signal-shaped record as accepted by graph's `buildCliOutput`. */
function sig(over: { ruleId: string; message: string; severity: string; filePath: string; line?: number }) {
  return { ruleId: over.ruleId, message: over.message, severity: over.severity, filePath: over.filePath, line: over.line };
}

describe('buildGraphSessionPayload', () => {
  it('persists the full rule-grouped detail from the CliOutput (no cap)', () => {
    const output = buildCliOutput(
      [
        sig({ ruleId: 'graph:god-file', message: 'too big', severity: 'high', filePath: 'a.ts', line: 1 }),
        sig({ ruleId: 'graph:dup-body', message: 'dup', severity: 'low', filePath: 'b.ts', line: 2 }),
        sig({ ruleId: 'graph:dup-body', message: 'dup', severity: 'low', filePath: 'c.ts', line: 3 }),
      ],
      'graph',
    );

    const payload = buildGraphSessionPayload(output);

    // Summary is carried verbatim.
    expect(payload.summary).toEqual(output.summary);
    // One check per rule; every finding is kept (3 signals → 3 findings total).
    expect(payload.checks).toHaveLength(2);
    const totalFindings = payload.checks.reduce((n, c) => n + c.findings.length, 0);
    expect(totalFindings).toBe(3);
    // The rule that emitted a high-severity signal is recorded as failed.
    const godFile = payload.checks.find(c => c.checkSlug === 'graph:god-file');
    expect(godFile?.passed).toBe(false);
    expect(godFile?.findings[0]?.severity).toBe('error');
    // Detail carries the fields the dashboard renderer reads.
    expect(godFile?.findings[0]?.filePath).toBe('a.ts');
  });

  it('returns an empty checks list for a run with no signals', () => {
    const payload = buildGraphSessionPayload(buildCliOutput([], 'graph'));
    expect(payload.checks).toEqual([]);
    expect(payload.summary.total).toBe(0);
  });
});
