/**
 * Tier-1 (in-process) unit tests for the gitleaks JSON parser + redaction
 * (ADR-0090 D6 Tier 1). The committed golden drives the normalized-signal golden;
 * a dedicated case proves NO raw `Secret`/`Match` substring survives normalization.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { normalizedSignalShape } from '@opensip-cli/external-tool-adapter';
import { describe, expect, it } from 'vitest';

import { parseGitleaksJson } from '../parse-gitleaks-json.js';

import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

const GOLDEN_RAW = readFileSync(
  fileURLToPath(new URL('../../__fixtures__/gitleaks-golden.json', import.meta.url)),
  'utf8',
);
const EXPECTED = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../__fixtures__/expected-signals.json', import.meta.url)),
    'utf8',
  ),
) as unknown[];

// The matched-credential strings the parser must NEVER let escape (the golden's
// `Secret` and `Match` values).
const RAW_SECRETS = ['AKIAIOSFODNN7EXAMPLE', 'glpat-XXXXXXXXXXXXXXXXXXXX', 'aws_key = AKIA'];

/** A minimal context — the gitleaks parser ignores it entirely. */
const CTX = { tool: 'gitleaks' } as unknown as AdapterRunContext;

function parsed(raw: string): ParsedScannerOutput {
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    json = undefined;
  }
  return { kind: 'json', raw, ...(json === undefined ? {} : { json }) };
}

describe('parseGitleaksJson', () => {
  it('normalizes the golden to the expected signal shapes', () => {
    const signals = parseGitleaksJson(parsed(GOLDEN_RAW), CTX);
    expect(signals.map(normalizedSignalShape)).toEqual(EXPECTED);
  });

  it('maps every secret to a high-severity security signal from gitleaks', () => {
    const signals = parseGitleaksJson(parsed(GOLDEN_RAW), CTX);
    expect(signals).toHaveLength(2);
    for (const s of signals) {
      expect(s.severity).toBe('high');
      expect(s.category).toBe('security');
      expect(s.source).toBe('gitleaks');
    }
  });

  it('carries native metadata (fingerprint, entropy, tags) and a NULL native severity', () => {
    const [first] = parseGitleaksJson(parsed(GOLDEN_RAW), CTX);
    expect(first?.metadata).toMatchObject({
      nativeFingerprint: 'config/prod.env:aws-access-token:12',
      entropy: 3.65,
      tags: ['key', 'AWS'],
      nativeSeverity: null,
    });
  });

  it('REDACTS the raw secret to a short preview and never leaks Secret/Match', () => {
    const signals = parseGitleaksJson(parsed(GOLDEN_RAW), CTX);
    // The preview is a 4-char + ellipsis mask, never the full credential.
    expect(signals[0]?.metadata.secretPreview).toBe('AKIA…');
    expect(signals[1]?.metadata.secretPreview).toBe('glpa…');

    // No raw secret/match substring anywhere in the serialized signals.
    const serialized = JSON.stringify(signals);
    for (const raw of RAW_SECRETS) {
      expect(serialized).not.toContain(raw);
    }
    // And the `Match` field is dropped entirely (never copied to metadata).
    expect(serialized).not.toContain('"Match"');
    expect(serialized.toLowerCase()).not.toContain('aws_key =');
  });

  it('returns [] for a clean run (empty array)', () => {
    expect(parseGitleaksJson(parsed('[]'), CTX)).toEqual([]);
  });

  it('returns [] for malformed JSON (never throws)', () => {
    expect(parseGitleaksJson({ kind: 'json', raw: 'not json{' }, CTX)).toEqual([]);
  });

  it('returns [] when the document is not an array', () => {
    expect(parseGitleaksJson(parsed('{"results":[]}'), CTX)).toEqual([]);
  });

  it('skips non-object array entries', () => {
    const signals = parseGitleaksJson(parsed('["nope", 42, null]'), CTX);
    expect(signals).toEqual([]);
  });

  it('applies defensive fallbacks for a finding missing RuleID/Description/File and omits absent line/column', () => {
    const signals = parseGitleaksJson(parsed('[{"Secret":"x"}]'), CTX);
    expect(signals).toHaveLength(1);
    const [s] = signals;
    expect(s?.ruleId).toBe('gitleaks-secret');
    expect(s?.message).toBe('Secret detected (gitleaks-secret)');
    expect(s?.filePath).toBe('');
    expect(s?.line).toBeUndefined();
    expect(s?.column).toBeUndefined();
    // A 1-char secret collapses to the bare ellipsis (never the raw value).
    expect(s?.metadata.secretPreview).toBe('…');
  });

  it('omits secretPreview entirely when no Secret field is present', () => {
    const [s] = parseGitleaksJson(parsed('[{"RuleID":"r","File":"f"}]'), CTX);
    expect(s?.metadata).not.toHaveProperty('secretPreview');
  });

  it('parses from raw bytes when the descriptor has no pre-parsed json', () => {
    // The acceptance-harness path passes only raw; the parser must still work.
    const signals = parseGitleaksJson({ kind: 'json', raw: GOLDEN_RAW }, CTX);
    expect(signals).toHaveLength(2);
  });
});
