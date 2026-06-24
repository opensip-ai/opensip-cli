import { describe, expect, it } from 'vitest';

import { BootstrapDiagnosticsCollector, isRelevantDiagnostic } from '../bootstrap-diagnostics.js';
import {
  capabilityDiscoveryToCliDiagnostic,
  fitnessEmptyCheckRegistryDiagnostic,
  fitnessPluginLoadFailedDiagnostic,
} from '../capability-diagnostic.js';
import {
  CLI_DIAGNOSTIC_CODES,
  formatCliDiagnosticHuman,
  withLogRef,
  type CliDiagnostic,
} from '../cli-diagnostic.js';

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

describe('CLI diagnostic helpers', () => {
  it('formats optional action and log reference lines for humans', () => {
    const rendered = formatCliDiagnosticHuman({
      ...fitnessDiag,
      action: 'Fix the manifest.',
      logRef: 'run_123',
    });

    expect(rendered).toContain('opensip: warning');
    expect(rendered).toContain('impact: Skipped');
    expect(rendered).toContain('action: Fix the manifest.');
    expect(rendered).toContain('log: run_123');
  });

  it('stamps a log reference only when one is available and absent', () => {
    expect(withLogRef(fitnessDiag, 'run_123').logRef).toBe('run_123');
    expect(withLogRef({ ...fitnessDiag, logRef: 'existing' }, 'run_123').logRef).toBe('existing');
    expect(withLogRef(fitnessDiag).logRef).toBeUndefined();
  });

  it('maps capability and fitness load failures to typed diagnostics', () => {
    expect(
      capabilityDiscoveryToCliDiagnostic(
        {
          packageName: '@vendor/pack',
          message: 'bad export',
          evt: 'capability.bad_export',
        },
        'fit-pack',
        { toolId: 'fitness' },
      ),
    ).toEqual(
      expect.objectContaining({
        code: CLI_DIAGNOSTIC_CODES.OPENSIP_CAPABILITY_DOMAIN_LOAD_FAILED,
        category: 'degraded',
        provenance: expect.objectContaining({
          packageName: '@vendor/pack',
          capabilityDomain: 'fit-pack',
          toolId: 'fitness',
        }),
        logRef: 'capability.bad_export',
      }),
    );

    expect(fitnessEmptyCheckRegistryDiagnostic()).toEqual(
      expect.objectContaining({
        severity: 'error',
        code: CLI_DIAGNOSTIC_CODES.OPENSIP_FIT_EMPTY_CHECK_REGISTRY,
      }),
    );
    expect(fitnessPluginLoadFailedDiagnostic('boom')).toEqual(
      expect.objectContaining({
        severity: 'warning',
        code: CLI_DIAGNOSTIC_CODES.OPENSIP_FIT_CHECK_PACK_LOAD_FAILED,
        message: expect.stringContaining('boom'),
      }),
    );
  });
});
