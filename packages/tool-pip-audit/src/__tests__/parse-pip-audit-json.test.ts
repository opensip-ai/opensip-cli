import { describe, expect, it } from 'vitest';

import { parsePipAuditJson } from '../parse-pip-audit-json.js';

import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

const CTX = { projectRoot: '/proj', tool: 'pip-audit' } as unknown as AdapterRunContext;

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

describe('parsePipAuditJson', () => {
  it('emits one high-severity signal per vuln (id → ruleId, dependency label in the message)', () => {
    const raw = JSON.stringify({
      dependencies: [
        {
          name: 'flask',
          version: '1.0',
          vulns: [
            {
              id: 'PYSEC-2019-179',
              fix_versions: ['1.0.3'],
              aliases: ['CVE-2019-1010083'],
              description: 'Unexpected memory usage due to chunked encoding data.',
            },
          ],
        },
      ],
    });
    const signals = parsePipAuditJson(output(raw), CTX);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      ruleId: 'PYSEC-2019-179',
      severity: 'high',
      message: 'Unexpected memory usage due to chunked encoding data. (flask@1.0)',
      filePath: '',
    });
    expect(signals[0]?.suggestion).toBe('Upgrade to 1.0.3.');
    expect(signals[0]?.metadata).toMatchObject({
      dependency: 'flask',
      version: '1.0',
      aliases: 'CVE-2019-1010083',
      fixVersions: '1.0.3',
    });
  });

  it('yields NO signal for a clean dependency (empty vulns)', () => {
    const raw = JSON.stringify({
      dependencies: [{ name: 'requests', version: '2.31.0', vulns: [] }],
    });
    expect(parsePipAuditJson(output(raw), CTX)).toEqual([]);
  });

  it('audits only vulnerable deps when a mix is present', () => {
    const raw = JSON.stringify({
      dependencies: [
        { name: 'flask', version: '1.0', vulns: [{ id: 'PYSEC-2019-179' }] },
        { name: 'requests', version: '2.31.0', vulns: [] },
        { name: 'jinja2', version: '2.11.1', vulns: [{ id: 'PYSEC-2021-66' }] },
      ],
    });
    expect(parsePipAuditJson(output(raw), CTX).map((s) => s.ruleId)).toEqual([
      'PYSEC-2019-179',
      'PYSEC-2021-66',
    ]);
  });

  it('falls back to a default rule id and omits the suggestion / aliases when fields are absent', () => {
    const raw = JSON.stringify({ dependencies: [{ name: 'x', version: '1', vulns: [{}] }] });
    const [signal] = parsePipAuditJson(output(raw), CTX);
    expect(signal?.ruleId).toBe('pip-vulnerability');
    expect(signal?.message).toBe('pip-vulnerability (x@1)');
    expect(signal?.suggestion).toBeUndefined();
    expect(signal?.metadata).toMatchObject({ aliases: null, fixVersions: null });
  });

  it('labels the dependency by name only when the version is missing', () => {
    const raw = JSON.stringify({ dependencies: [{ name: 'lib', vulns: [{ id: 'V-1' }] }] });
    expect(parsePipAuditJson(output(raw), CTX)[0]?.message).toBe('V-1 (lib)');
  });

  it('tolerates malformed / non-JSON output and non-object entries without throwing', () => {
    expect(parsePipAuditJson(output('not json'), CTX)).toEqual([]);
    expect(parsePipAuditJson(output('{"unexpected":true}'), CTX)).toEqual([]);
    const raw = JSON.stringify({ dependencies: [null, 5, { name: 'x', vulns: [null, { id: 'V' }] }] });
    expect(parsePipAuditJson(output(raw), CTX).map((s) => s.ruleId)).toEqual(['V']);
  });
});
