import { describe, expect, it } from 'vitest';

import { buildOpenSipSarif, formatSignalSarif } from '../signal-sarif.js';

import { EMPTY_ENVELOPE, FIXTURE_ENVELOPE } from './envelope.fixtures.js';

import type { SignalEnvelope } from '@opensip-cli/contracts';

describe('formatSignalSarif', () => {
  it('renders the envelope as SARIF v2.1.0 (snapshot)', () => {
    expect(formatSignalSarif(FIXTURE_ENVELOPE)).toMatchSnapshot();
  });

  it('derives the driver name from the envelope tool', () => {
    const parsed = JSON.parse(formatSignalSarif(FIXTURE_ENVELOPE)) as {
      runs: { tool: { driver: { name: string } } }[];
    };
    expect(parsed.runs[0].tool.driver.name).toBe('opensip-cli-graph');
  });

  it('emits one result per signal with ruleId verbatim', () => {
    const parsed = JSON.parse(formatSignalSarif(FIXTURE_ENVELOPE)) as {
      runs: { results: { ruleId: string }[] }[];
    };
    expect(parsed.runs[0].results.map((r) => r.ruleId)).toEqual([
      'graph:orphan-subtree',
      'graph:large-function',
    ]);
  });

  it('preserves signal fingerprints as SARIF partial fingerprints', () => {
    const env: SignalEnvelope = {
      ...FIXTURE_ENVELOPE,
      signals: [
        {
          ...FIXTURE_ENVELOPE.signals[0],
          fingerprint: 'graph|src/foo.ts|10|3',
        },
      ],
    };
    const parsed = JSON.parse(formatSignalSarif(env)) as {
      runs: { results: { partialFingerprints?: Record<string, string> }[] }[];
    };
    expect(parsed.runs[0].results[0].partialFingerprints).toEqual({
      opensipFingerprint: 'graph|src/foo.ts|10|3',
    });
  });

  it('emits bounded OpenSIP result properties and drops unallowlisted metadata', () => {
    const env: SignalEnvelope = {
      ...FIXTURE_ENVELOPE,
      signals: [
        {
          ...FIXTURE_ENVELOPE.signals[0],
          fingerprint: 'fp-1',
          metadata: {
            baselineState: 'added',
            qualifiedName: 'src/foo.ts#foo',
            secretUnallowlisted: 'do-not-ship',
          },
          repair: {
            repairKind: 'manual',
            patchHint: { kind: 'text', summary: 'Use a narrower API' },
          },
        },
      ],
    };
    const parsed = JSON.parse(formatSignalSarif(env)) as {
      runs: {
        results: {
          properties: {
            openSipSchema: string;
            fingerprint?: string;
            metadata?: Record<string, unknown>;
            repair?: unknown;
          };
        }[];
      }[];
    };
    const props = parsed.runs[0].results[0].properties;
    expect(props.openSipSchema).toBe('opensip.signal-result.v1');
    expect(props.fingerprint).toBe('fp-1');
    expect(props.metadata).toEqual({
      baselineState: 'added',
      qualifiedName: 'src/foo.ts#foo',
    });
    expect(JSON.stringify(props)).not.toContain('do-not-ship');
    expect(props.repair).toEqual({
      repairKind: 'manual',
      patchHint: { kind: 'text', summary: 'Use a narrower API' },
    });
  });

  it('emits run properties from baseline identity and declared inputs', () => {
    const env: SignalEnvelope = {
      ...FIXTURE_ENVELOPE,
      declaredInputs: {
        cliVersion: '0.1.0',
        nodeVersion: '24.0.0',
        platform: 'test/arch',
        tool: 'graph',
        baselineIdentity: FIXTURE_ENVELOPE.baselineIdentity,
      },
    };
    const parsed = JSON.parse(formatSignalSarif(env)) as {
      runs: {
        properties?: {
          openSipSchema?: string;
          baselineIdentity?: unknown;
          declaredInputs?: { cliVersion?: string; tool?: string };
        };
      }[];
    };
    expect(parsed.runs[0].properties).toMatchObject({
      openSipSchema: 'opensip.signal-run.v1',
      baselineIdentity: FIXTURE_ENVELOPE.baselineIdentity,
      declaredInputs: { cliVersion: '0.1.0', tool: 'graph' },
    });
  });

  it('maps severity to SARIF level (high → error, medium → warning)', () => {
    const parsed = JSON.parse(formatSignalSarif(FIXTURE_ENVELOPE)) as {
      runs: { results: { level: string }[] }[];
    };
    expect(parsed.runs[0].results.map((r) => r.level)).toEqual(['error', 'warning']);
  });

  it('maps critical → error and low → note (exhaustive severity mapping)', () => {
    const env: SignalEnvelope = {
      ...FIXTURE_ENVELOPE,
      signals: [
        { ...FIXTURE_ENVELOPE.signals[0], severity: 'critical' },
        { ...FIXTURE_ENVELOPE.signals[1], severity: 'low' },
      ],
    };
    const parsed = JSON.parse(formatSignalSarif(env)) as {
      runs: { results: { level: string }[] }[];
    };
    expect(parsed.runs[0].results.map((r) => r.level)).toEqual(['error', 'note']);
  });

  it('emits a location with only a uri (no region) when the signal has no line/column', () => {
    const env: SignalEnvelope = {
      ...FIXTURE_ENVELOPE,
      signals: [
        {
          ...FIXTURE_ENVELOPE.signals[0],
          line: undefined,
          column: undefined,
          code: { file: 'src/whole.ts' },
        },
      ],
    };
    const parsed = JSON.parse(formatSignalSarif(env)) as {
      runs: {
        results: {
          locations: {
            physicalLocation: {
              artifactLocation: { uri: string };
              region?: unknown;
            };
          }[];
        }[];
      }[];
    };
    const loc = parsed.runs[0].results[0].locations[0].physicalLocation;
    expect(loc.artifactLocation.uri).toBe('src/whole.ts');
    expect(loc.region).toBeUndefined();
  });

  it('falls back to filePath/line/column when the signal carries no code hint', () => {
    const env: SignalEnvelope = {
      ...FIXTURE_ENVELOPE,
      signals: [
        {
          ...FIXTURE_ENVELOPE.signals[0],
          code: undefined,
          filePath: 'src/legacy.ts',
          line: 5,
          column: undefined,
        },
      ],
    };
    const parsed = JSON.parse(formatSignalSarif(env)) as {
      runs: {
        results: {
          locations: {
            physicalLocation: {
              artifactLocation: { uri: string };
              region?: { startLine?: number; startColumn?: number };
            };
          }[];
        }[];
      }[];
    };
    const loc = parsed.runs[0].results[0].locations[0].physicalLocation;
    expect(loc.artifactLocation.uri).toBe('src/legacy.ts');
    expect(loc.region).toEqual({ startLine: 5 });
  });

  it('emits 1-based signal columns as SARIF startColumn (ADR-0179; fails on main off-by-one)', () => {
    // On main, a 0-based emitter could store column 5 and SARIF would print
    // startColumn 5 (wrong character). After ADR-0179, createSignal admits only
    // 1-based columns; a correct emitter stores 6 for 0-based index 5.
    const env: SignalEnvelope = {
      ...FIXTURE_ENVELOPE,
      signals: [
        {
          ...FIXTURE_ENVELOPE.signals[0],
          code: { file: 'src/col.ts', line: 1, column: 6 },
          filePath: 'src/col.ts',
          line: 1,
          column: 6,
        },
      ],
    };
    const parsed = JSON.parse(formatSignalSarif(env)) as {
      runs: {
        results: {
          locations: {
            physicalLocation: {
              region?: { startLine?: number; startColumn?: number };
            };
          }[];
        }[];
      }[];
    };
    expect(parsed.runs[0].results[0].locations[0].physicalLocation.region).toEqual({
      startLine: 1,
      startColumn: 6,
    });
  });

  it('omits region coordinates < 1 (SARIF requires startLine/startColumn >= 1)', () => {
    const env: SignalEnvelope = {
      ...FIXTURE_ENVELOPE,
      signals: [
        // A whole-line finding reports column 0 ("no specific column"). SARIF
        // rejects 0, so the column is dropped, leaving a valid line-only region.
        {
          ...FIXTURE_ENVELOPE.signals[0],
          code: undefined,
          filePath: 'src/zero-col.ts',
          line: 23,
          column: 0,
        },
        // Both coordinates < 1 → the whole region is omitted.
        {
          ...FIXTURE_ENVELOPE.signals[1],
          code: undefined,
          filePath: 'src/none.ts',
          line: 0,
          column: 0,
        },
      ],
    };
    const parsed = JSON.parse(formatSignalSarif(env)) as {
      runs: {
        results: {
          locations: {
            physicalLocation: {
              region?: { startLine?: number; startColumn?: number };
            };
          }[];
        }[];
      }[];
    };
    const [r0, r1] = parsed.runs[0].results;
    expect(r0.locations[0].physicalLocation.region).toEqual({ startLine: 23 });
    expect(r1.locations[0].physicalLocation.region).toBeUndefined();
  });

  it('omits fractional region coordinates that are invalid in SARIF', () => {
    const env: SignalEnvelope = {
      ...FIXTURE_ENVELOPE,
      signals: [
        {
          ...FIXTURE_ENVELOPE.signals[0],
          code: undefined,
          filePath: 'src/fractional-line.ts',
          line: 4.5,
          column: 2,
        },
        {
          ...FIXTURE_ENVELOPE.signals[1],
          code: undefined,
          filePath: 'src/fractional-column.ts',
          line: 5,
          column: 2.5,
        },
      ],
    };
    const parsed = JSON.parse(formatSignalSarif(env)) as {
      runs: {
        results: {
          locations: {
            physicalLocation: {
              region?: { startLine?: number; startColumn?: number };
            };
          }[];
        }[];
      }[];
    };
    const [fractionalLine, fractionalColumn] = parsed.runs[0].results;
    expect(fractionalLine.locations[0].physicalLocation.region).toBeUndefined();
    expect(fractionalColumn.locations[0].physicalLocation.region).toEqual({ startLine: 5 });
  });

  it('percent-encodes a filePath with a space and a # into a valid URI reference, preserving separators', () => {
    // Raw spaces/'#'/'?' produce an invalid RFC 3986 URI reference (GitHub
    // Code Scanning can mis-locate or reject the result). Each path segment
    // is encoded independently so literal '/' separators survive.
    const env: SignalEnvelope = {
      ...FIXTURE_ENVELOPE,
      signals: [
        {
          ...FIXTURE_ENVELOPE.signals[0],
          code: undefined,
          filePath: 'src/weird dir/file#1.ts',
          line: 3,
          column: undefined,
        },
      ],
    };
    const parsed = JSON.parse(formatSignalSarif(env)) as {
      runs: {
        results: {
          locations: {
            physicalLocation: { artifactLocation: { uri: string } };
          }[];
        }[];
      }[];
    };
    const uri = parsed.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri;
    expect(uri).toBe('src/weird%20dir/file%231.ts');
    // The result is a well-formed URI reference: parseable, and round-trips
    // back to the original path when percent-decoded segment-by-segment.
    expect(() => new URL(uri, 'file:///base/')).not.toThrow();
    expect(uri.split('/').map(decodeURIComponent).join('/')).toBe('src/weird dir/file#1.ts');
  });

  it('produces a single run with no results for an empty envelope', () => {
    const parsed = JSON.parse(formatSignalSarif(EMPTY_ENVELOPE)) as {
      version: string;
      runs: { results: unknown[] }[];
    };
    expect(parsed.version).toBe('2.1.0');
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0].results).toHaveLength(0);
  });

  it('is pure — same input renders byte-identical output', () => {
    expect(formatSignalSarif(FIXTURE_ENVELOPE)).toBe(formatSignalSarif(FIXTURE_ENVELOPE));
  });
});

describe('buildOpenSipSarif', () => {
  it('uses the supplied driver identity verbatim', () => {
    const sarif = buildOpenSipSarif(FIXTURE_ENVELOPE.signals, {
      name: 'opensip-cli-graph',
      version: '9.9.9',
    });
    const parsed = JSON.parse(sarif) as {
      runs: { tool: { driver: { name: string; version: string } } }[];
    };
    expect(parsed.runs[0].tool.driver.name).toBe('opensip-cli-graph');
    expect(parsed.runs[0].tool.driver.version).toBe('9.9.9');
  });
});
