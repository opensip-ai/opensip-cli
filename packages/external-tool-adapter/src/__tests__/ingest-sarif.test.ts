import { createSignal } from '@opensip-cli/core';
import { buildOpenSipSarif } from '@opensip-cli/output';
import { describe, expect, it } from 'vitest';

import { normalizedSignalShape } from '../acceptance-harness.js';
import { messageHashFingerprintStrategy } from '../fingerprint.js';
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

/**
 * A Trivy-shaped result: the STABLE rule title in `shortDescription`, and a
 * VERBOSE, version-volatile block in `result.message.text` (the `Installed
 * Version:` line shifts on every dependency bump). `installed` parameterizes that
 * volatile line.
 */
function trivyLikeSarif(installed: string): SarifLog {
  return {
    runs: [
      {
        tool: {
          driver: {
            name: 'Trivy',
            rules: [
              {
                id: 'CVE-2023-37920',
                shortDescription: { text: 'certifi: Removal of e-Tugra root certificate' },
                properties: { 'security-severity': '9.8' },
              },
            ],
          },
        },
        results: [
          {
            ruleId: 'CVE-2023-37920',
            ruleIndex: 0,
            level: 'error',
            message: {
              text: `Package: certifi\nInstalled Version: ${installed}\nVulnerability CVE-2023-37920\nSeverity: CRITICAL\nFixed Version: 2023.7.22\nLink: https://avd.aquasec.com/nvd/cve-2023-37920`,
            },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: 'requirements.txt' },
                  region: { startLine: 1 },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('ingestSarif — stable rule-title message (A9, version-invariant fingerprint basis)', () => {
  it('uses the rule shortDescription as Signal.message and stashes the verbose block in metadata.detail', () => {
    const [signal] = ingestSarif(trivyLikeSarif('2022.12.7'), { source: 'trivy' });
    expect(signal.message).toBe('certifi: Removal of e-Tugra root certificate');
    expect(signal.metadata.detail).toContain('Package: certifi');
    expect(signal.metadata.detail).toContain('Installed Version: 2022.12.7');
  });

  it('keeps the message-hash fingerprint STABLE when only the verbose Installed Version line churns', () => {
    const [oldVer] = ingestSarif(trivyLikeSarif('2022.12.7'), { source: 'trivy' });
    const [newVer] = ingestSarif(trivyLikeSarif('2023.5.7'), { source: 'trivy' });
    // The verbose detail differs across the dependency bump...
    expect(oldVer.metadata.detail).not.toBe(newVer.metadata.detail);
    // ...but the stable title (and thus the message-hash fingerprint basis) does not,
    // so the baseline does NOT churn — message-hash's whole reason for being.
    expect(oldVer.message).toBe(newVer.message);
    expect(messageHashFingerprintStrategy.fingerprint(oldVer)).toBe(
      messageHashFingerprintStrategy.fingerprint(newVer),
    );
  });

  it('falls back to result.message.text when the rule has no shortDescription (no detail stashed)', () => {
    const [signal] = ingestSarif({
      runs: [
        {
          tool: { driver: { name: 'X', rules: [{ id: 'R' }] } },
          results: [
            {
              ruleId: 'R',
              ruleIndex: 0,
              message: { text: 'verbose only' },
              locations: [{ physicalLocation: { artifactLocation: { uri: 'f' } } }],
            },
          ],
        },
      ],
    });
    expect(signal.message).toBe('verbose only');
    expect(signal.metadata.detail).toBeUndefined();
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
