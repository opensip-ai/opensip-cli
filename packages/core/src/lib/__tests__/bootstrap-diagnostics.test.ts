import { describe, expect, it } from 'vitest';

import { BootstrapDiagnosticsCollector, isRelevantDiagnostic } from '../bootstrap-diagnostics.js';
import { CLI_DIAGNOSTIC_CODES, type CliDiagnostic } from '../cli-diagnostic.js';

const fitnessDiag: CliDiagnostic = {
  severity: 'warning',
  code: CLI_DIAGNOSTIC_CODES.OPENSIP_DISCOVERY_TOOL_MANIFEST_INVALID,
  category: 'discovery',
  message: 'Bad fitness manifest',
  impact: 'Skipped',
  provenance: {
    toolId: 'fitness',
    packageName: '@opensip-cli/fitness',
    discoverySource: 'installed',
  },
};

const graphDiag: CliDiagnostic = {
  severity: 'warning',
  code: CLI_DIAGNOSTIC_CODES.OPENSIP_DISCOVERY_TOOL_MANIFEST_INVALID,
  category: 'discovery',
  message: 'Bad graph manifest',
  impact: 'Skipped',
  provenance: {
    toolId: 'graph',
    packageName: '@third/graph',
    discoverySource: 'installed',
  },
};

describe('isRelevantDiagnostic', () => {
  it('matches diagnostics by toolId', () => {
    expect(isRelevantDiagnostic(fitnessDiag, 'fitness')).toBe(true);
    expect(isRelevantDiagnostic(fitnessDiag, 'graph')).toBe(false);
  });

  it('matches diagnostics by capability domain', () => {
    const diag: CliDiagnostic = {
      ...fitnessDiag,
      provenance: { capabilityDomain: 'fit-pack' },
    };
    expect(isRelevantDiagnostic(diag, undefined, 'fit-pack')).toBe(true);
    expect(isRelevantDiagnostic(diag, 'graph', 'fit-pack')).toBe(true);
  });
});

describe('BootstrapDiagnosticsCollector', () => {
  it('filters command-scoped diagnostics for normal command rendering', () => {
    const collector = new BootstrapDiagnosticsCollector();
    collector.record(fitnessDiag);
    collector.record(graphDiag);
    expect(collector.filterForCommand('graph')).toEqual([graphDiag]);
    expect(collector.list()).toHaveLength(2);
  });
});
