import { type ResolvedTrustPolicy } from '@opensip-cli/config';

import { getBootstrapDiagnosticsBuffer } from './bootstrap-diagnostics-buffer.js';
import { PolicyAuditCollector } from './policy-audit.js';
import { loadPreScopePolicySources, type LoadPreScopePolicySourcesInput } from './policy-source.js';

export interface BootstrapPolicyState {
  readonly policy: ResolvedTrustPolicy;
  readonly audit: PolicyAuditCollector;
}

export function resolveBootstrapPolicyState(
  input: LoadPreScopePolicySourcesInput,
): BootstrapPolicyState {
  const audit = new PolicyAuditCollector();
  const sources = loadPreScopePolicySources(input);
  for (const diagnostic of sources.diagnostics) {
    getBootstrapDiagnosticsBuffer().record({
      severity: sources.policy.orgStatus.state === 'required-unavailable' ? 'error' : 'warning',
      code: 'OPENSIP_POLICY_SOURCE_INVALID',
      category: 'configuration',
      message: 'Policy source could not be fully resolved.',
      impact: diagnostic,
      action: 'Fix the policy source or add a valid org policy cache.',
    });
  }
  return { policy: sources.policy, audit };
}
