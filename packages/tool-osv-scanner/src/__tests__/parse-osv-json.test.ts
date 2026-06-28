/**
 * Tier-1 (in-process) unit tests for the OSV-Scanner JSON parser (ADR-0090 D6
 * Tier 1). The committed golden drives the normalized-signal golden; dedicated
 * cases prove the three severity paths (CVSS `max_severity`, the GHSA
 * `MODERATE → medium` label, and the no-severity `medium` default).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { normalizedSignalShape } from '@opensip-cli/external-tool-adapter';
import { describe, expect, it } from 'vitest';

import { parseOsvJson } from '../parse-osv-json.js';

import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

const GOLDEN_RAW = readFileSync(
  fileURLToPath(new URL('../../__fixtures__/osv-golden.json', import.meta.url)),
  'utf8',
);
const EXPECTED = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../__fixtures__/expected-signals.json', import.meta.url)),
    'utf8',
  ),
) as unknown[];

/** A minimal context — the osv-scanner parser ignores it entirely. */
const CTX = { tool: 'osv-scanner' } as unknown as AdapterRunContext;

function parsed(raw: string): ParsedScannerOutput {
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    json = undefined;
  }
  return { kind: 'json', raw, ...(json === undefined ? {} : { json }) };
}

describe('parseOsvJson', () => {
  it('normalizes the golden to the expected signal shapes', () => {
    const signals = parseOsvJson(parsed(GOLDEN_RAW), CTX);
    expect(signals.map(normalizedSignalShape)).toEqual(EXPECTED);
  });

  it('maps every vulnerability to a security signal from osv-scanner', () => {
    const signals = parseOsvJson(parsed(GOLDEN_RAW), CTX);
    expect(signals).toHaveLength(2);
    for (const s of signals) {
      expect(s.category).toBe('security');
      expect(s.source).toBe('osv-scanner');
    }
  });

  it('CVSS path: groups[].max_severity "7.5" → high, preserving the raw label + score', () => {
    const [first] = parseOsvJson(parsed(GOLDEN_RAW), CTX);
    expect(first?.severity).toBe('high');
    expect(first?.metadata).toMatchObject({
      aliases: ['CVE-2019-10744'],
      ecosystem: 'npm',
      pkg: 'lodash',
      installed: '4.17.15',
      cvss: '7.5',
      nativeSeverity: 'HIGH',
    });
    // The lockfile finding carries no line/column anchor.
    expect(first?.line).toBeUndefined();
    expect(first?.column).toBeUndefined();
    expect(first?.filePath).toBe('package-lock.json');
  });

  it('LABEL path: database_specific.severity "MODERATE" (no max_severity) → medium', () => {
    const [, second] = parseOsvJson(parsed(GOLDEN_RAW), CTX);
    expect(second?.severity).toBe('medium');
    expect(second?.metadata).toMatchObject({
      cvss: null,
      nativeSeverity: 'MODERATE',
    });
  });

  it('carries the advisory details as a suggestion', () => {
    const [first] = parseOsvJson(parsed(GOLDEN_RAW), CTX);
    expect(first?.suggestion).toContain('Prototype Pollution');
  });

  it('DEFAULT path: a vuln with no max_severity and no label defaults to medium (nativeSeverity null)', () => {
    const doc = JSON.stringify({
      results: [
        {
          source: { path: 'go.mod' },
          packages: [
            {
              package: { name: 'example', version: '1.0.0', ecosystem: 'Go' },
              vulnerabilities: [{ id: 'GO-2024-0001', summary: 'Some issue' }],
              groups: [{ ids: ['GO-2024-0001'] }],
            },
          ],
        },
      ],
    });
    const [s] = parseOsvJson(parsed(doc), CTX);
    expect(s?.severity).toBe('medium');
    expect(s?.metadata.nativeSeverity).toBeNull();
    expect(s?.metadata.cvss).toBeNull();
  });

  it('CRITICAL / LOW labels map straight through when no CVSS score is present', () => {
    const doc = JSON.stringify({
      results: [
        {
          source: { path: 'requirements.txt' },
          packages: [
            {
              package: { name: 'pkg-c', version: '1.0.0', ecosystem: 'PyPI' },
              vulnerabilities: [
                { id: 'V-CRIT', summary: 'crit', database_specific: { severity: 'CRITICAL' } },
                { id: 'V-LOW', summary: 'low', database_specific: { severity: 'LOW' } },
              ],
              groups: [{ ids: ['V-CRIT'] }, { ids: ['V-LOW'] }],
            },
          ],
        },
      ],
    });
    const signals = parseOsvJson(parsed(doc), CTX);
    expect(signals.map((s) => s.severity)).toEqual(['critical', 'low']);
  });

  it('CVSS max_severity wins over the GHSA label when both are present', () => {
    const doc = JSON.stringify({
      results: [
        {
          source: { path: 'package-lock.json' },
          packages: [
            {
              package: { name: 'pkg-x', version: '2.0.0', ecosystem: 'npm' },
              // Label says MODERATE, but the numeric score is critical-band (9.8).
              vulnerabilities: [
                { id: 'V-X', summary: 'x', database_specific: { severity: 'MODERATE' } },
              ],
              groups: [{ ids: ['V-X'], max_severity: '9.8' }],
            },
          ],
        },
      ],
    });
    const [s] = parseOsvJson(parsed(doc), CTX);
    expect(s?.severity).toBe('critical');
    expect(s?.metadata.cvss).toBe('9.8');
    expect(s?.metadata.nativeSeverity).toBe('MODERATE');
  });

  it('falls back defensively for a vuln missing id/summary/package fields', () => {
    const doc = JSON.stringify({
      results: [{ source: { path: 'Cargo.lock' }, packages: [{ vulnerabilities: [{}] }] }],
    });
    const [s] = parseOsvJson(parsed(doc), CTX);
    expect(s?.ruleId).toBe('osv-vulnerability');
    expect(s?.message).toBe('osv-vulnerability');
    expect(s?.metadata).toMatchObject({ pkg: null, installed: null, ecosystem: null });
    expect(s?.filePath).toBe('Cargo.lock');
  });

  it('returns [] for a clean run (empty results) — the nothing-scanned no-op', () => {
    expect(parseOsvJson(parsed('{"results":[]}'), CTX)).toEqual([]);
    expect(parseOsvJson(parsed('{}'), CTX)).toEqual([]);
  });

  it('returns [] for malformed JSON (never throws)', () => {
    expect(parseOsvJson({ kind: 'json', raw: 'not json{' }, CTX)).toEqual([]);
  });

  it('returns [] when the document is an array (wrong shape), not an object', () => {
    expect(parseOsvJson(parsed('[1,2,3]'), CTX)).toEqual([]);
  });

  it('skips non-object packages / vulnerabilities entries', () => {
    const doc = JSON.stringify({
      results: [{ source: { path: 'p' }, packages: ['nope', { vulnerabilities: [42, null] }] }],
    });
    expect(parseOsvJson(parsed(doc), CTX)).toEqual([]);
  });

  it('parses from raw bytes when the descriptor has no pre-parsed json', () => {
    // The acceptance-harness path passes only raw; the parser must still work.
    const signals = parseOsvJson({ kind: 'json', raw: GOLDEN_RAW }, CTX);
    expect(signals).toHaveLength(2);
  });
});
