import { createSignal } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { stampProvenance, stampProvenanceAll } from '../provenance.js';

import type { AdapterProvenance } from '../types.js';

const provenance: AdapterProvenance = {
  tool: 'gitleaks',
  adapterPackage: '@opensip-cli/tool-gitleaks',
  binaryPath: '/usr/bin/gitleaks',
  binaryVersion: '8.18.0',
  args: ['detect', '--no-git'],
  configPath: '/proj/opensip-cli.config.yml',
};

describe('stampProvenance', () => {
  it('adds tool/adapterPackage/binary/args/configPath under metadata.provenance', () => {
    const signal = createSignal({
      source: 'gitleaks',
      severity: 'high',
      ruleId: 'aws',
      message: 'm',
      metadata: { x: 1 },
    });
    const out = stampProvenance(signal, provenance);
    expect(out.metadata.x).toBe(1);
    expect(out.metadata.provenance).toEqual({
      tool: 'gitleaks',
      adapterPackage: '@opensip-cli/tool-gitleaks',
      binaryPath: '/usr/bin/gitleaks',
      binaryVersion: '8.18.0',
      args: ['detect', '--no-git'],
      configPath: '/proj/opensip-cli.config.yml',
    });
  });

  it('drops undefined optional fields and never mutates the input', () => {
    const signal = createSignal({ source: 'trivy', severity: 'low', ruleId: 'r', message: 'm' });
    const out = stampProvenance(signal, { tool: 'trivy', binaryPath: '/bin/trivy', args: [] });
    expect(out.metadata.provenance).toEqual({ tool: 'trivy', binaryPath: '/bin/trivy', args: [] });
    expect(signal.metadata.provenance).toBeUndefined();
  });

  it('stampProvenanceAll maps a batch', () => {
    const signals = [
      createSignal({ source: 'g', severity: 'high', ruleId: 'a', message: 'm1' }),
      createSignal({ source: 'g', severity: 'low', ruleId: 'b', message: 'm2' }),
    ];
    const out = stampProvenanceAll(signals, provenance);
    expect(out).toHaveLength(2);
    expect(out.every((s) => s.metadata.provenance !== undefined)).toBe(true);
  });
});
