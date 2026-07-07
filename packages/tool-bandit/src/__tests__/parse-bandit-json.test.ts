import { describe, expect, it } from 'vitest';

import { parseBanditJson } from '../parse-bandit-json.js';

import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

const CTX = {
  projectRoot: '/proj',
  tool: 'bandit',
} as unknown as AdapterRunContext;

/** Build the `ParsedScannerOutput` the run loop hands a JSON-kind parser. */
function output(raw: string): ParsedScannerOutput {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  return { kind: 'json', raw, ...(json === undefined ? {} : { json }) };
}

describe('parseBanditJson', () => {
  it('normalizes a result (test_id → ruleId, filename/line_number/col_offset → location)', () => {
    const raw = JSON.stringify({
      results: [
        {
          test_id: 'B602',
          test_name: 'subprocess_popen_with_shell_equals_true',
          filename: 'app.py',
          line_number: 10,
          col_offset: 4,
          issue_severity: 'HIGH',
          issue_confidence: 'HIGH',
          issue_text: 'subprocess call with shell=True identified, security issue.',
        },
      ],
    });
    const signals = parseBanditJson(output(raw), CTX);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      ruleId: 'B602',
      severity: 'high',
      message: 'subprocess call with shell=True identified, security issue.',
      filePath: 'app.py',
      line: 10,
      column: 4,
    });
  });

  it('maps issue_severity HIGH/MEDIUM/LOW → high/medium/low', () => {
    const raw = JSON.stringify({
      results: [
        {
          test_id: 'B1',
          filename: 'a.py',
          issue_severity: 'HIGH',
          issue_text: 'h',
        },
        {
          test_id: 'B2',
          filename: 'a.py',
          issue_severity: 'MEDIUM',
          issue_text: 'm',
        },
        {
          test_id: 'B3',
          filename: 'a.py',
          issue_severity: 'LOW',
          issue_text: 'l',
        },
      ],
    });
    expect(parseBanditJson(output(raw), CTX).map((s) => s.severity)).toEqual([
      'high',
      'medium',
      'low',
    ]);
  });

  it('defaults severity to medium when issue_severity is absent/unknown', () => {
    const raw = JSON.stringify({
      results: [{ test_id: 'B9', filename: 'a.py', issue_text: 'x' }],
    });
    const [signal] = parseBanditJson(output(raw), CTX);
    expect(signal?.severity).toBe('medium');
    expect(signal?.metadata?.nativeSeverity).toBeNull();
  });

  it('preserves the native severity, confidence, test_name and CWE on metadata', () => {
    const raw = JSON.stringify({
      results: [
        {
          test_id: 'B602',
          test_name: 'subprocess_popen_with_shell_equals_true',
          filename: 'a.py',
          issue_severity: 'HIGH',
          issue_confidence: 'HIGH',
          issue_text: 'x',
          issue_cwe: {
            id: 78,
            link: 'https://cwe.mitre.org/data/definitions/78.html',
          },
        },
      ],
    });
    const [signal] = parseBanditJson(output(raw), CTX);
    expect(signal?.metadata).toMatchObject({
      nativeSeverity: 'HIGH',
      confidence: 'HIGH',
      testName: 'subprocess_popen_with_shell_equals_true',
      cwe: 'CWE-78',
      cweLink: 'https://cwe.mitre.org/data/definitions/78.html',
    });
  });

  it('falls back to test_name then "bandit" for the rule id, and issue_text→ruleId for the message', () => {
    const byName = parseBanditJson(
      output(
        JSON.stringify({
          results: [{ test_name: 'blacklist', filename: 'a.py' }],
        }),
      ),
      CTX,
    );
    expect(byName[0]?.ruleId).toBe('blacklist');
    expect(byName[0]?.message).toBe('blacklist');

    const bare = parseBanditJson(output(JSON.stringify({ results: [{ filename: 'a.py' }] })), CTX);
    expect(bare[0]?.ruleId).toBe('bandit');
    expect(bare[0]?.message).toBe('bandit');
  });

  it('returns no signals for a clean run (empty results)', () => {
    expect(parseBanditJson(output('{"results":[],"errors":[]}'), CTX)).toEqual([]);
  });

  it('tolerates malformed / non-JSON output without throwing (zero signals)', () => {
    expect(parseBanditJson(output('not json at all'), CTX)).toEqual([]);
    expect(parseBanditJson(output('[1,2,3]'), CTX)).toEqual([]);
  });

  it('skips result entries that are not objects', () => {
    const raw = JSON.stringify({
      results: [null, 5, 'x', { test_id: 'B1', filename: 'a.py' }],
    });
    expect(parseBanditJson(output(raw), CTX)).toHaveLength(1);
  });
});
