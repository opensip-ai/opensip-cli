import { describe, expect, it } from 'vitest';

import {
  BOOTSTRAP_DIAGNOSTIC_ORIGIN,
  BootstrapDiagnosticsCollector,
  cliDiagnosticToEvent,
  isRelevantDiagnostic,
  mergeBootstrapIntoRunDiagnostics,
} from '../bootstrap-diagnostics.js';
import { capabilityDiscoveryToCliDiagnostic } from '../capability-diagnostic.js';
import {
  CLI_DIAGNOSTIC_CODES,
  formatCliDiagnosticHuman,
  withLogRef,
  type CliDiagnostic,
} from '../cli-diagnostic.js';

import type { RunDiagnostics } from '../run-diagnostics.js';

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

  it('returns true for global diagnostics with no provenance', () => {
    expect(isRelevantDiagnostic({ ...fitnessDiag, provenance: undefined }, 'graph')).toBe(true);
  });

  it('matches diagnostics by package name', () => {
    expect(isRelevantDiagnostic(fitnessDiag, '@opensip-cli/fitness')).toBe(true);
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

  it('returns every buffered diagnostic when no command filter is supplied', () => {
    const collector = new BootstrapDiagnosticsCollector();
    collector.record(fitnessDiag);
    collector.record(graphDiag);
    expect(collector.filterForCommand()).toEqual([fitnessDiag, graphDiag]);
  });
});

/**
 * OBS-DIAG / ADR-0176 — projector + merge for the outcome diagnostics plane.
 * On main, assemble-outcome only snapshots DiagnosticsBus and never reads this
 * buffer, so capability/policy bootstrap diagnostics never appear under --json.
 */
describe('cliDiagnosticToEvent + mergeBootstrapIntoRunDiagnostics (ADR-0176)', () => {
  const at = '2026-07-20T12:00:00.000Z';

  it('projects a discovery CliDiagnostic to a discover/warn event with origin bootstrap', () => {
    const event = cliDiagnosticToEvent(fitnessDiag, at);
    expect(event).toEqual({
      phase: 'discover',
      level: 'warn',
      message: fitnessDiag.message,
      at,
      data: {
        origin: BOOTSTRAP_DIAGNOSTIC_ORIGIN,
        code: fitnessDiag.code,
        category: 'discovery',
        impact: fitnessDiag.impact,
        provenance: fitnessDiag.provenance,
      },
    });
  });

  it('maps severity error → level error and non-discovery categories → load phase', () => {
    const policy: CliDiagnostic = {
      severity: 'error',
      code: CLI_DIAGNOSTIC_CODES.OPENSIP_POLICY_DENIED,
      category: 'configuration',
      message: 'policy denied pack',
      impact: 'Pack not loaded',
      action: 'opensip policy trust …',
    };
    const event = cliDiagnosticToEvent(policy, at);
    expect(event.phase).toBe('load');
    expect(event.level).toBe('error');
    expect(event.data).toMatchObject({
      origin: BOOTSTRAP_DIAGNOSTIC_ORIGIN,
      code: CLI_DIAGNOSTIC_CODES.OPENSIP_POLICY_DENIED,
      action: 'opensip policy trust …',
    });
  });

  it('prepends bootstrap events onto a lifecycle snapshot without mutating sources', () => {
    const base: RunDiagnostics = {
      runId: 'run_1',
      events: [
        {
          phase: 'execute',
          level: 'info',
          message: 'handler ran',
          at,
        },
      ],
      metrics: { 'tools.loaded': 1 },
    };
    const merged = mergeBootstrapIntoRunDiagnostics(base, [fitnessDiag], at);
    expect(merged.runId).toBe('run_1');
    expect(merged.metrics).toEqual({ 'tools.loaded': 1 });
    expect(merged.events).toHaveLength(2);
    expect(merged.events[0].data?.origin).toBe(BOOTSTRAP_DIAGNOSTIC_ORIGIN);
    expect(merged.events[0].message).toBe(fitnessDiag.message);
    expect(merged.events[1].message).toBe('handler ran');
    // Sources unchanged.
    expect(base.events).toHaveLength(1);
    expect(mergeBootstrapIntoRunDiagnostics(base, [])).toBe(base);
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
  });
});
