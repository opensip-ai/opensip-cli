import { createSignal } from '@opensip-cli/core';
import { buildOpenSipSarif } from '@opensip-cli/output';
import { describe, expect, it } from 'vitest';

import { normalizedSignalShape } from '../acceptance-harness.js';
import { ingestSarif } from '../ingest-sarif.js';

import type { SarifLog } from '../ingest-sarif.js';

describe('ingestSarif — severity recovery from security-severity (the core job)', () => {
  it('recovers critical from CVSS >= 9.0 even when level is the lossy "error"', () => {
    const sarif: SarifLog = {
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'Trivy',
              rules: [{ id: 'CVE-2023-37920', properties: { 'security-severity': '9.8' } }],
            },
          },
          results: [
            {
              ruleId: 'CVE-2023-37920',
              ruleIndex: 0,
              level: 'error',
              message: { text: 'certifi: removal of e-Tugra root certificate' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'requirements.txt' },
                    region: { startLine: 1, startColumn: 1 },
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const [signal] = ingestSarif(sarif, { source: 'trivy' });
    expect(signal.severity).toBe('critical');
    expect(signal.ruleId).toBe('CVE-2023-37920');
    expect(signal.filePath).toBe('requirements.txt');
    expect(signal.line).toBe(1);
    expect(signal.metadata.securitySeverity).toBe('9.8');
    expect(signal.metadata.nativeLevel).toBe('error');
    // host-stamped later — not at ingest time.
    expect(signal.fingerprint).toBeUndefined();
  });

  it('applies CVSS bands across rules and joins ruleIndex→rules', () => {
    const sarif: SarifLog = {
      runs: [
        {
          tool: {
            driver: {
              name: 'Trivy',
              rules: [
                { id: 'A', properties: { 'security-severity': '7.5' } },
                { id: 'B', properties: { 'security-severity': '5.0' } },
                { id: 'C', properties: { 'security-severity': '2.0' } },
              ],
            },
          },
          results: [
            {
              ruleIndex: 0,
              level: 'error',
              message: { text: 'a' },
              locations: [{ physicalLocation: { artifactLocation: { uri: 'f' } } }],
            },
            { ruleIndex: 1, level: 'warning', message: { text: 'b' }, locations: [] },
            { ruleIndex: 2, level: 'note', message: { text: 'c' } },
          ],
        },
      ],
    };
    const signals = ingestSarif(sarif);
    expect(signals.map((s) => s.severity)).toEqual(['high', 'medium', 'low']);
    expect(signals.map((s) => s.ruleId)).toEqual(['A', 'B', 'C']);
  });

  it('falls back to level when no security-severity is present (error→high, never critical)', () => {
    const sarif: SarifLog = {
      runs: [
        {
          tool: { driver: { name: 'Gitleaks', rules: [{ id: 'R' }] } },
          results: [
            {
              ruleId: 'R',
              ruleIndex: 0,
              level: 'error',
              message: { text: 'm' },
              locations: [{ physicalLocation: { artifactLocation: { uri: 'x' } } }],
            },
          ],
        },
      ],
    };
    const [signal] = ingestSarif(sarif);
    expect(signal.severity).toBe('high');
  });
});

describe('ingestSarif — defensive over foreign output', () => {
  it('preserves guid / fingerprints / helpUri / extra-locations on metadata', () => {
    const sarif: SarifLog = {
      runs: [
        {
          tool: { driver: { name: 'X', rules: [{ id: 'R', helpUri: 'https://help' }] } },
          results: [
            {
              ruleId: 'R',
              ruleIndex: 0,
              guid: 'abc-guid',
              fingerprints: { primary: 'fp1' },
              message: { text: 'm' },
              locations: [
                { physicalLocation: { artifactLocation: { uri: 'a' }, region: { startLine: 3 } } },
                { physicalLocation: { artifactLocation: { uri: 'b' } } },
              ],
            },
          ],
        },
      ],
    };
    const [signal] = ingestSarif(sarif);
    expect(signal.metadata.nativeFingerprint).toBe('abc-guid');
    expect(signal.metadata.helpUri).toBe('https://help');
    expect(signal.metadata.additionalLocations).toBe(1);
    expect(signal.filePath).toBe('a');
    expect(signal.line).toBe(3);
  });

  it('handles multiple runs, missing rules, and a ruleId without a descriptor', () => {
    const sarif: SarifLog = {
      runs: [
        {
          tool: { driver: { name: 'one' } },
          results: [{ ruleId: 'NoRule', message: { text: 'm1' } }],
        },
        { results: [{ message: { text: 'm2' } }] },
      ],
    };
    const signals = ingestSarif(sarif);
    expect(signals).toHaveLength(2);
    expect(signals[0].ruleId).toBe('NoRule');
    expect(signals[1].ruleId).toBe('unknown');
  });

  it('tolerates empty / runless logs', () => {
    expect(ingestSarif({})).toEqual([]);
    expect(ingestSarif({ runs: [] })).toEqual([]);
    expect(ingestSarif({ runs: [{}] })).toEqual([]);
  });

  it('derives the source from the driver name when none is supplied', () => {
    const [signal] = ingestSarif({
      runs: [
        { tool: { driver: { name: 'Trivy' } }, results: [{ ruleId: 'r', message: { text: 'm' } }] },
      ],
    });
    expect(signal.source).toBe('trivy');
  });
});

describe('ingestSarif — round-trip against buildOpenSipSarif (the writer is the inverse)', () => {
  it('is identity on ruleId/message/file/line/column for high/medium/low signals', () => {
    const inputs = [
      createSignal({
        source: 'trivy',
        severity: 'high',
        ruleId: 'CVE-1',
        message: 'high finding',
        code: { file: 'a.txt', line: 3, column: 2 },
      }),
      createSignal({
        source: 'trivy',
        severity: 'medium',
        ruleId: 'CVE-2',
        message: 'medium finding',
        code: { file: 'b.txt', line: 10 },
      }),
      createSignal({
        source: 'trivy',
        severity: 'low',
        ruleId: 'CVE-3',
        message: 'low finding',
        code: { file: 'c.txt' },
      }),
    ];
    const sarif = JSON.parse(
      buildOpenSipSarif(inputs, { name: 'opensip-cli-trivy', version: '1.0.0' }),
    ) as SarifLog;
    const out = ingestSarif(sarif, { source: 'trivy' });
    expect(out.map(normalizedSignalShape)).toEqual(inputs.map(normalizedSignalShape));
  });

  it('documents the lossy collapse: a critical writes as SARIF error and reads back as high', () => {
    const input = createSignal({
      source: 'trivy',
      severity: 'critical',
      ruleId: 'CVE-X',
      message: 'crit',
      code: { file: 'd.txt', line: 1 },
    });
    const sarif = JSON.parse(
      buildOpenSipSarif([input], { name: 'opensip-cli-trivy', version: '1.0.0' }),
    ) as SarifLog;
    const [out] = ingestSarif(sarif);
    // No security-severity in the writer's output → level-only fallback → high (never critical).
    expect(out.severity).toBe('high');
    expect(out.ruleId).toBe('CVE-X');
  });
});
