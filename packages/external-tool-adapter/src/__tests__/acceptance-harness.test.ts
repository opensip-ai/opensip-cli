import { createSignal } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { normalizedSignalShape, runAcceptanceCase } from '../acceptance-harness.js';

describe('runAcceptanceCase', () => {
  it('drives a SARIF golden through the shared ingest and builds a deterministic envelope', () => {
    const sarif = JSON.stringify({
      runs: [
        {
          tool: {
            driver: {
              name: 'Trivy',
              rules: [{ id: 'CVE-1', properties: { 'security-severity': '9.8' } }],
            },
          },
          results: [
            {
              ruleId: 'CVE-1',
              ruleIndex: 0,
              level: 'error',
              message: { text: 'crit' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'req.txt' },
                    region: { startLine: 1 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const { signals, envelope } = runAcceptanceCase({ tool: 'trivy', kind: 'sarif', raw: sarif });
    expect(signals).toHaveLength(1);
    expect(signals[0].severity).toBe('critical');
    expect(envelope.tool).toBe('trivy');
    expect(envelope.verdict.passed).toBe(false); // a critical is error-rung
    // Worker-side message-hash stamping applied through buildSignalEnvelope.
    expect(envelope.signals[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('drives a JSON golden through the descriptor parse', () => {
    const { signals, envelope } = runAcceptanceCase({
      tool: 'osv-scanner',
      kind: 'json',
      raw: '{"results":[{"id":"GHSA-1"}]}',
      parse: (raw) => {
        const id = (raw.json as { results: { id: string }[] }).results[0].id;
        return [
          createSignal({
            source: 'osv-scanner',
            severity: 'low',
            ruleId: id,
            message: id,
            code: { file: 'lock' },
          }),
        ];
      },
    });
    expect(signals.map((s) => s.ruleId)).toEqual(['GHSA-1']);
    expect(envelope.verdict.passed).toBe(true); // only low-rung
  });

  it('returns no signals for a stdout fixture without a parse', () => {
    const { signals } = runAcceptanceCase({ tool: 't', kind: 'stdout', raw: 'whatever' });
    expect(signals).toEqual([]);
  });

  it('hands a usable run context (logger + artifactPath) to the descriptor parse', () => {
    let artifact = '';
    runAcceptanceCase({
      tool: 'gitleaks',
      kind: 'stdout',
      raw: 'AKIAIOSFODNN7EXAMPLE',
      parse: (raw, ctx) => {
        ctx.logger.info({ evt: 'test', module: 'm' });
        artifact = ctx.artifactPath('out.json');
        return [
          createSignal({
            source: ctx.tool,
            severity: 'high',
            ruleId: 'r',
            message: raw.raw.slice(0, 4),
          }),
        ];
      },
    });
    expect(artifact).toBe('/acceptance/acceptance-run/out.json');
  });

  it('normalizedSignalShape projects the stable fields', () => {
    const s = createSignal({
      source: 't',
      severity: 'high',
      ruleId: 'R',
      message: 'm',
      code: { file: 'a', line: 3, column: 2 },
    });
    expect(normalizedSignalShape(s)).toEqual({
      ruleId: 'R',
      severity: 'high',
      message: 'm',
      file: 'a',
      line: 3,
      column: 2,
    });
  });
});
