import { describe, expect, it } from 'vitest';

import { buildOpenSipSarif, formatSignalSarif } from '../signal-sarif.js';

import { EMPTY_ENVELOPE, FIXTURE_ENVELOPE } from './envelope.fixtures.js';

import type { SignalEnvelope } from '@opensip-tools/contracts';

describe('formatSignalSarif', () => {
  it('renders the envelope as SARIF v2.1.0 (snapshot)', () => {
    expect(formatSignalSarif(FIXTURE_ENVELOPE)).toMatchSnapshot();
  });

  it('derives the driver name from the envelope tool', () => {
    const parsed = JSON.parse(formatSignalSarif(FIXTURE_ENVELOPE)) as {
      runs: { tool: { driver: { name: string } } }[];
    };
    expect(parsed.runs[0].tool.driver.name).toBe('opensip-tools-graph');
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
            physicalLocation: { artifactLocation: { uri: string }; region?: unknown };
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
            physicalLocation: { region?: { startLine?: number; startColumn?: number } };
          }[];
        }[];
      }[];
    };
    const [r0, r1] = parsed.runs[0].results;
    expect(r0.locations[0].physicalLocation.region).toEqual({ startLine: 23 });
    expect(r1.locations[0].physicalLocation.region).toBeUndefined();
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
      name: 'opensip-tools-graph',
      version: '9.9.9',
    });
    const parsed = JSON.parse(sarif) as {
      runs: { tool: { driver: { name: string; version: string } } }[];
    };
    expect(parsed.runs[0].tool.driver.name).toBe('opensip-tools-graph');
    expect(parsed.runs[0].tool.driver.version).toBe('9.9.9');
  });
});
