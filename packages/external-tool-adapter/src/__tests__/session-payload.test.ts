/**
 * session-payload — the adapter-owned, dashboard-shaped session detail blob
 * (A2: an adapter session must carry `summary` + grouped `checks[]` so the HTML
 * report renders a secret/vuln scan's findings instead of falsely "clean").
 *
 * Proves the grouped shape AND the secret-hygiene invariant: every field is
 * copied from an already-redacted signal, and `metadata` is narrowed to JSON
 * scalars (the nested provenance object is dropped) — so NO raw credential reaches
 * the persisted payload.
 */

import { createSignal, type Signal } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { buildAdapterSessionPayload } from '../session-payload.js';

/** A `high`-severity (error-rung) secret signal carrying ONLY a redacted preview. */
function leakSignal(overrides: Partial<Parameters<typeof createSignal>[0]> = {}): Signal {
  return createSignal({
    source: 'gitleaks',
    category: 'security',
    severity: 'high',
    ruleId: 'aws-access-token',
    message: 'AWS Access Key',
    code: { file: 'config/prod.env', line: 12, column: 19 },
    // The provenance object + a redacted scalar preview — the raw secret is NEVER
    // present (the ingest parser masked it). The provenance object must be dropped.
    metadata: {
      secretPreview: 'AKIA…',
      entropy: 3.65,
      provenance: { tool: 'gitleaks', adapterPackage: '@opensip-cli/tool-gitleaks' },
    },
    ...overrides,
  });
}

describe('buildAdapterSessionPayload', () => {
  it('groups signals by ruleId into checks[] with a populated summary (NOT clean)', () => {
    const payload = buildAdapterSessionPayload([
      leakSignal(),
      leakSignal({ ruleId: 'aws-access-token', code: { file: 'a.env', line: 3 } }),
      leakSignal({
        ruleId: 'stripe-token',
        message: 'Stripe Token',
        code: { file: 'b.ts', line: 9 },
      }),
    ]);

    expect(payload.__version).toBe(1);
    // Two distinct rules → two checks; the aws rule grouped both occurrences.
    expect(payload.checks).toHaveLength(2);
    const aws = payload.checks.find((c) => c.checkSlug === 'aws-access-token');
    expect(aws?.violationCount).toBe(2);
    expect(aws?.findings).toHaveLength(2);
    expect(aws?.passed).toBe(false); // error-rung findings ⇒ the rule failed

    // The summary the dashboard reads for its clean/dirty decision — NOT clean.
    expect(payload.summary).toEqual({
      total: 2, // rules that fired
      passed: 0,
      failed: 2,
      errors: 3, // high-severity signal count
      warnings: 0,
    });
    // The dashboard's `clean = errors === 0 && warnings === 0` is therefore FALSE.
    expect(payload.summary.errors === 0 && payload.summary.warnings === 0).toBe(false);
  });

  it('collapses 4-level severity to the dashboard 2-level bucket and marks a warning rule passed', () => {
    const payload = buildAdapterSessionPayload([
      leakSignal({ ruleId: 'low-rule', severity: 'low', message: 'minor' }),
    ]);
    const check = payload.checks[0];
    expect(check?.findings[0]?.severity).toBe('warning');
    // A rule with only warning-rung findings does NOT fail (fit/graph semantics).
    expect(check?.passed).toBe(true);
    expect(payload.summary).toMatchObject({ errors: 0, warnings: 1, passed: 1, failed: 0 });
  });

  it('an empty scan yields zero checks and a zeroed summary', () => {
    const payload = buildAdapterSessionPayload([]);
    expect(payload.checks).toHaveLength(0);
    expect(payload.summary).toEqual({ total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 });
  });

  it('carries per-finding file/line/column/suggestion and projects metadata to scalars', () => {
    const payload = buildAdapterSessionPayload([
      leakSignal({ suggestion: 'rotate the credential' }),
    ]);
    const finding = payload.checks[0]?.findings[0];
    expect(finding?.filePath).toBe('config/prod.env');
    expect(finding?.line).toBe(12);
    expect(finding?.column).toBe(19);
    expect(finding?.suggestion).toBe('rotate the credential');
    // Scalar metadata survives; the nested provenance OBJECT is dropped.
    expect(finding?.metadata).toEqual({ secretPreview: 'AKIA…', entropy: 3.65 });
    expect((finding?.metadata as Record<string, unknown>).provenance).toBeUndefined();
  });

  it('omits absent optional fields and keeps structured repair guidance', () => {
    // A "bare" signal (no code ⇒ no file/line/column, no scalar metadata, no
    // suggestion) and a repair-carrying signal — exercises both arms of every
    // optional spread and the empty-metadata path.
    const bare = createSignal({
      source: 'osv-scanner',
      severity: 'high',
      ruleId: 'r',
      message: 'm',
    });
    const withRepair = createSignal({
      source: 'osv-scanner',
      severity: 'high',
      ruleId: 'r2',
      message: 'm2',
      repair: { repairKind: 'manual', autofixable: false },
    });
    const payload = buildAdapterSessionPayload([bare, withRepair]);
    const bareFinding = payload.checks.find((c) => c.checkSlug === 'r')?.findings[0];
    expect(bareFinding?.filePath).toBe('');
    expect(bareFinding?.line).toBeUndefined();
    expect(bareFinding?.column).toBeUndefined();
    expect(bareFinding?.suggestion).toBeUndefined();
    expect(bareFinding?.metadata).toBeUndefined();
    const repairFinding = payload.checks.find((c) => c.checkSlug === 'r2')?.findings[0];
    expect(repairFinding?.repair).toEqual({ repairKind: 'manual', autofixable: false });
  });

  it('NEVER lets a raw secret or the Match key reach the serialized payload (redaction proof)', () => {
    // The signal carries ONLY a masked preview (redaction happens at ingest, before
    // the envelope/payload build). Prove the serialized blob the host persists holds
    // no raw credential bytes and no `Match` field.
    const RAW_SECRET = 'AKIAIOSFODNN7EXAMPLE';
    const payload = buildAdapterSessionPayload([leakSignal()]);
    const blob = JSON.stringify(payload);
    expect(blob).not.toContain(RAW_SECRET);
    expect(blob).not.toContain('"Match"');
    expect(blob).not.toContain('"Secret"');
    // The masked preview IS present (the finding stays identifiable).
    expect(blob).toContain('AKIA…');
  });
});
