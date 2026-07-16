import { BootstrapDiagnosticsCollector, ConfigurationError } from '@opensip-cli/core';
import { describe, expect, it, vi } from 'vitest';

import { PolicyAuditCollector } from '../policy-audit.js';
import { resolvePolicyForRun } from '../run-policy.js';

import type * as ConfigModule from '@opensip-cli/config';
import type { ProjectContext } from '@opensip-cli/core';

vi.mock('@opensip-cli/config', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  return {
    ...actual,
    readGlobalTrustPolicy: vi.fn(() => ({})),
  };
});

const PROJECT: ProjectContext = {
  cwd: '/repo',
  cwdExplicit: false,
  scope: 'project',
  projectRoot: '/repo',
  configPath: '/repo/opensip-cli.config.yml',
  walkedUp: 0,
};

function baseArgs(
  overrides: {
    readonly parentCommand?: string;
    readonly configDocument?: unknown;
    readonly toolConfig?: unknown;
    readonly diagnostics?: BootstrapDiagnosticsCollector;
    readonly bootstrapPolicyAudit?: PolicyAuditCollector;
  } = {},
) {
  return {
    project: PROJECT,
    runId: 'run-1',
    parentCommand: overrides.parentCommand ?? 'graph',
    configDocument: overrides.configDocument ?? {},
    toolConfig: overrides.toolConfig ?? {},
    diagnostics: overrides.diagnostics ?? new BootstrapDiagnosticsCollector(),
    ...(overrides.bootstrapPolicyAudit === undefined
      ? {}
      : { bootstrapPolicyAudit: overrides.bootstrapPolicyAudit }),
  };
}

describe('resolvePolicyForRun', () => {
  it('skips disabled-check enforcement for non-fitness commands and merges bootstrap audit', () => {
    const bootstrapAudit = new PolicyAuditCollector();
    bootstrapAudit.record({
      occurredAt: '2026-07-02T00:00:00.000Z',
      action: 'load',
      subject: 'installed-tool:demo',
      outcome: 'allow',
      sourceTier: 'project',
      reasons: ['ok'],
      exceptionIds: [],
      metadata: {},
    });

    const result = resolvePolicyForRun(
      baseArgs({
        parentCommand: 'graph',
        toolConfig: { fitness: { disabledChecks: ['no-console'] } },
        bootstrapPolicyAudit: bootstrapAudit,
      }),
    );

    expect(result.policy.mode).toBe('default');
    expect(result.audit.list()).toHaveLength(1);
    expect(bootstrapAudit.list()).toEqual([]);
  });

  it('denies disabled fitness checks under strict policy without an exception', () => {
    const diagnostics = new BootstrapDiagnosticsCollector();

    expect(() =>
      resolvePolicyForRun(
        baseArgs({
          parentCommand: 'fit',
          configDocument: { policy: { mode: 'strict' } },
          toolConfig: { fitness: { disabledChecks: ['no-console', 42, 'no-alert'] } },
          diagnostics,
        }),
      ),
    ).toThrow(ConfigurationError);

    expect(diagnostics.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'OPENSIP_POLICY_DENIED',
        }),
      ]),
    );
  });

  it('warns when disabled checks are conditionally allowed by optional org-policy failure', () => {
    const diagnostics = new BootstrapDiagnosticsCollector();

    const result = resolvePolicyForRun(
      baseArgs({
        parentCommand: 'fitness',
        configDocument: {
          policy: {
            org: { required: false, cachePath: '.opensip/missing-org-policy.json' },
          },
        },
        toolConfig: { fitness: { disabledChecks: ['no-console'] } },
        diagnostics,
      }),
    );

    expect(result.audit.list()).toHaveLength(1);
    expect(diagnostics.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'warning',
          code: 'OPENSIP_POLICY_SOURCE_INVALID',
        }),
        expect.objectContaining({
          severity: 'warning',
          code: 'OPENSIP_POLICY_CONDITIONED',
        }),
      ]),
    );
  });
});
