import { describe, expect, it } from 'vitest';

import { parseGovulncheckJsonLines } from '../parse-govulncheck-json-lines.js';

import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

const CTX = {
  projectRoot: '/proj',
  tool: 'govulncheck',
} as unknown as AdapterRunContext;

/** govulncheck streams NDJSON to stdout. */
function output(lines: string[]): ParsedScannerOutput {
  return { kind: 'stdout', raw: lines.join('\n') };
}

const osv = (id: string, summary: string, aliases?: string[]): string =>
  JSON.stringify({
    osv: { id, summary, ...(aliases === undefined ? {} : { aliases }) },
  });

describe('parseGovulncheckJsonLines', () => {
  it('DEDUPES multiple finding messages per OSV into one high (reachable) signal', () => {
    const raw = output([
      osv('GO-2024-0001', 'Vuln in foo', ['CVE-2024-1111']),
      // A reachable finding (has a `function` frame) …
      JSON.stringify({
        finding: {
          osv: 'GO-2024-0001',
          fixed_version: '1.2.3',
          trace: [
            {
              module: 'm',
              package: 'p',
              function: 'Vuln',
              position: { filename: 'main.go', line: 10, column: 2 },
            },
          ],
        },
      }),
      // … plus a duplicate import-only finding for the SAME OSV.
      JSON.stringify({
        finding: {
          osv: 'GO-2024-0001',
          trace: [{ module: 'm', package: 'p' }],
        },
      }),
    ]);
    const signals = parseGovulncheckJsonLines(raw, CTX);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      ruleId: 'GO-2024-0001',
      severity: 'high',
      message: 'Vuln in foo',
      filePath: 'main.go',
      line: 10,
      column: 2,
    });
  });

  it('marks an import-only OSV (no function frame) medium with the "(imported, not called)" suffix', () => {
    const raw = output([
      osv('GO-2024-0002', 'Import-only vuln'),
      JSON.stringify({
        finding: {
          osv: 'GO-2024-0002',
          trace: [
            {
              module: 'm',
              package: 'p',
              position: { filename: 'util.go', line: 7 },
            },
          ],
        },
      }),
    ]);
    const [signal] = parseGovulncheckJsonLines(raw, CTX);
    expect(signal?.severity).toBe('medium');
    expect(signal?.message).toBe('Import-only vuln (imported, not called)');
    expect(signal?.filePath).toBe('util.go');
  });

  it('collapses the fixture to exactly two signals (one high, one medium)', () => {
    const raw = output([
      osv('GO-2024-0001', 'Reachable', ['CVE-2024-1111']),
      osv('GO-2024-0002', 'ImportOnly'),
      JSON.stringify({
        finding: {
          osv: 'GO-2024-0001',
          trace: [
            {
              module: 'm',
              package: 'p',
              function: 'F',
              position: { filename: 'a.go', line: 1 },
            },
          ],
        },
      }),
      JSON.stringify({
        finding: {
          osv: 'GO-2024-0001',
          trace: [{ module: 'm', package: 'p' }],
        },
      }),
      JSON.stringify({
        finding: {
          osv: 'GO-2024-0002',
          trace: [
            {
              module: 'm',
              package: 'p',
              position: { filename: 'b.go', line: 2 },
            },
          ],
        },
      }),
    ]);
    const signals = parseGovulncheckJsonLines(raw, CTX);
    expect(signals).toHaveLength(2);
    expect(signals.filter((s) => s.severity === 'high')).toHaveLength(1);
    expect(signals.filter((s) => s.severity === 'medium')).toHaveLength(1);
  });

  it('prefers the reachable trace even when the import-only finding is seen first', () => {
    const raw = output([
      osv('GO-2024-0003', 'Order test'),
      // import-only first
      JSON.stringify({
        finding: {
          osv: 'GO-2024-0003',
          trace: [{ module: 'm', package: 'p' }],
        },
      }),
      // reachable second — should win
      JSON.stringify({
        finding: {
          osv: 'GO-2024-0003',
          trace: [
            {
              module: 'm',
              package: 'p',
              function: 'F',
              position: { filename: 'c.go', line: 3 },
            },
          ],
        },
      }),
    ]);
    const [signal] = parseGovulncheckJsonLines(raw, CTX);
    expect(signal?.severity).toBe('high');
    expect(signal?.filePath).toBe('c.go');
  });

  it('falls back to a generic message when the OSV advisory has no summary', () => {
    const raw = output([
      JSON.stringify({
        finding: {
          osv: 'GO-2024-0004',
          trace: [
            {
              module: 'm',
              package: 'p',
              function: 'F',
              position: { filename: 'd.go', line: 4 },
            },
          ],
        },
      }),
    ]);
    const [signal] = parseGovulncheckJsonLines(raw, CTX);
    expect(signal?.message).toBe('Go vulnerability detected (GO-2024-0004)');
  });

  it('ignores config/progress lines and returns no signals for a clean run', () => {
    const raw = output([
      JSON.stringify({ config: { protocol_version: 'v1.0.0' } }),
      JSON.stringify({ progress: { message: 'Scanning...' } }),
    ]);
    expect(parseGovulncheckJsonLines(raw, CTX)).toEqual([]);
  });

  it('tolerates malformed / non-JSON lines without throwing', () => {
    expect(parseGovulncheckJsonLines(output(['not json']), CTX)).toEqual([]);
    expect(parseGovulncheckJsonLines(output(['']), CTX)).toEqual([]);
  });
});
