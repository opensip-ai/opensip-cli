import { describe, expect, it } from 'vitest';

import { buildOpenSipSarif, formatSignalSarif } from '../signal-sarif.js';
import { EMPTY_ENVELOPE, FIXTURE_ENVELOPE } from './fixtures.js';

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
