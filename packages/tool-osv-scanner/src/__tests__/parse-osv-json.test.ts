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

// ── CVSS v3.1 base-score helper (A10 fixture-consistency guard) ──────────────
//
// Real osv-scanner derives `groups[].max_severity` as the max CVSS base score
// across the group's members, so a member's `CVSS_V3` vector can never disagree
// with its group's max_severity. This small, self-contained CVSS-v3.1 base-score
// calculator lets the golden assert that invariant: max_severity ≥ the score the
// member's vector computes. (Equation per FIRST CVSS v3.1 §7.) A future
// contradictory golden — like the prior `9.8`-vector vuln tagged `max_severity:"7.5"`
// — then fails loudly instead of banding the wrong severity.
const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC: Record<string, number> = { L: 0.77, H: 0.44 };
const PR_U: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const PR_C: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 };
const UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

/** CVSS 3.1 "Roundup": smallest 1-decimal number ≥ input (FIRST appendix A). */
function roundUp(input: number): number {
  const intInput = Math.round(input * 100_000);
  return intInput % 10_000 === 0 ? intInput / 100_000 : (Math.floor(intInput / 10_000) + 1) / 10;
}

/** Compute the CVSS v3.x base score from a vector string (`CVSS:3.1/AV:N/.../A:H`). */
function cvss3BaseScore(vector: string): number {
  const m = new Map(
    vector
      .split('/')
      .map((part) => part.split(':'))
      .filter((pair): pair is [string, string] => pair.length === 2)
      .map(([k, v]) => [k, v] as const),
  );
  const scopeChanged = m.get('S') === 'C';
  const iscBase =
    1 - (1 - CIA[m.get('C') ?? 'N']) * (1 - CIA[m.get('I') ?? 'N']) * (1 - CIA[m.get('A') ?? 'N']);
  const impact = scopeChanged
    ? 7.52 * (iscBase - 0.029) - 3.25 * (iscBase - 0.02) ** 15
    : 6.42 * iscBase;
  const pr = (scopeChanged ? PR_C : PR_U)[m.get('PR') ?? 'N'];
  const exploitability =
    8.22 * AV[m.get('AV') ?? 'N'] * AC[m.get('AC') ?? 'L'] * pr * UI[m.get('UI') ?? 'N'];
  if (impact <= 0) return 0;
  const raw = scopeChanged ? 1.08 * (impact + exploitability) : impact + exploitability;
  return roundUp(Math.min(raw, 10));
}

interface GoldenDoc {
  results: {
    packages: {
      vulnerabilities?: {
        id: string;
        severity?: { type: string; score: string }[];
      }[];
      groups?: { ids: string[]; max_severity?: string }[];
    }[];
  }[];
}

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

  it('CVSS path: groups[].max_severity "9.8" → critical, preserving the raw label + score', () => {
    // A10: the golden member carries the 9.8 vector (C:H/I:H/A:H), so the group's
    // max_severity is 9.8 and the band is `critical` — a real osv-scanner capture
    // could never pair that vector with a 7.5 max_severity (see the self-consistency
    // guard below). VERIFY-against-installed-osv for the exact emitted values.
    const [first] = parseOsvJson(parsed(GOLDEN_RAW), CTX);
    expect(first?.severity).toBe('critical');
    expect(first?.metadata).toMatchObject({
      aliases: ['CVE-2019-10744'],
      ecosystem: 'npm',
      pkg: 'lodash',
      installed: '4.17.15',
      cvss: '9.8',
      nativeSeverity: 'CRITICAL',
    });
    // The lockfile finding carries no line/column anchor.
    expect(first?.line).toBeUndefined();
    expect(first?.column).toBeUndefined();
    expect(first?.filePath).toBe('package-lock.json');
  });

  it('CVSS path: the second golden member (minimist, 9.8 vector) is also critical', () => {
    // A10: minimist CVE-2021-44906 is 9.8/CRITICAL at NVD (vector C:H/I:H/A:H), so
    // its group max_severity is 9.8 — the prior fixture fabricated an omitted
    // max_severity → MODERATE path. VERIFY-against-installed-osv.
    const [, second] = parseOsvJson(parsed(GOLDEN_RAW), CTX);
    expect(second?.severity).toBe('critical');
    expect(second?.metadata).toMatchObject({
      aliases: ['CVE-2021-44906'],
      pkg: 'minimist',
      installed: '1.2.5',
      cvss: '9.8',
      nativeSeverity: 'CRITICAL',
    });
  });

  it('LABEL fallback: database_specific.severity "MODERATE" with no CVSS score → medium', () => {
    // Synthetic case (not a real-binary golden): an advisory that carries a GHSA
    // label but NO CVSS vector / max_severity (e.g. some Go or reserved-CVE records)
    // falls back to the label, and MODERATE ⇒ medium — the one non-obvious mapping.
    const doc = JSON.stringify({
      results: [
        {
          source: { path: 'go.mod' },
          packages: [
            {
              package: { name: 'pkg-mod', version: '1.0.0', ecosystem: 'Go' },
              vulnerabilities: [
                {
                  id: 'GO-2024-1234',
                  summary: 'mod issue',
                  database_specific: { severity: 'MODERATE' },
                },
              ],
              groups: [{ ids: ['GO-2024-1234'] }],
            },
          ],
        },
      ],
    });
    const [s] = parseOsvJson(parsed(doc), CTX);
    expect(s?.severity).toBe('medium');
    expect(s?.metadata).toMatchObject({ cvss: null, nativeSeverity: 'MODERATE' });
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

describe('osv-golden.json — CVSS self-consistency (A10 guard)', () => {
  it('the base-score helper computes 9.8 for the C:H/I:H/A:H network vector', () => {
    // Sanity-pin the helper against a known FIRST example before trusting it below.
    expect(cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
    expect(cvss3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N')).toBe(0);
  });

  it('every CVSS_V3 golden member has a group max_severity ≥ the score its vector computes', () => {
    // The load-bearing invariant: osv-scanner sets max_severity to the max base
    // score across members, so it can never be LOWER than a member vector's score.
    // The prior golden (9.8 vector, max_severity "7.5") violated this and banded the
    // lodash finding "high" where a real binary yields "critical".
    const doc = JSON.parse(GOLDEN_RAW) as GoldenDoc;
    let checked = 0;
    for (const result of doc.results) {
      for (const pkg of result.packages) {
        for (const vuln of pkg.vulnerabilities ?? []) {
          const vector = (vuln.severity ?? []).find((s) => s.type === 'CVSS_V3')?.score;
          if (vector === undefined) continue;
          const group = (pkg.groups ?? []).find((g) => g.ids.includes(vuln.id));
          const maxSeverity = Number.parseFloat(group?.max_severity ?? '');
          expect(Number.isFinite(maxSeverity)).toBe(true);
          expect(maxSeverity).toBeGreaterThanOrEqual(cvss3BaseScore(vector));
          checked += 1;
        }
      }
    }
    // Guard the guard: the golden must actually exercise at least one CVSS_V3 member.
    expect(checked).toBeGreaterThan(0);
  });
});
