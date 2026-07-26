import { readGlobalTrustPolicy, type ResolvedTrustPolicy } from '@opensip-cli/config';
import {
  ConfigurationError,
  isPlainRecord,
  type BootstrapDiagnosticsCollector,
  type ProjectContext,
} from '@opensip-cli/core';

import { hostErrorCatalog } from '../errors/host-error-catalog.js';

import { PolicyAuditCollector } from './policy-audit.js';
import { policyCiEvidenceFromCurrentEnv } from './policy-evidence.js';
import { evaluatePolicyPep } from './policy-pep.js';
import { readValidatedProjectPolicy, resolveRuntimePolicy } from './policy-source.js';

// Plan 01 clean break: registered host definitions replace bare code literals that only
// resolved through legacyFamilyCode's head-guessing.
const POLICY_DENIED = hostErrorCatalog.require('CONFIGURATION.POLICY.DENIED');

export interface ResolvedRunPolicy {
  readonly policy: ResolvedTrustPolicy;
  readonly audit: PolicyAuditCollector;
}

export function resolvePolicyForRun(args: {
  readonly project: ProjectContext;
  readonly runId: string;
  readonly parentCommand: string;
  readonly configDocument: unknown;
  readonly toolConfig: unknown;
  readonly diagnostics: BootstrapDiagnosticsCollector;
  readonly bootstrapPolicyAudit?: PolicyAuditCollector;
}): ResolvedRunPolicy {
  const userPolicy = readGlobalTrustPolicy();
  if (userPolicy.error !== undefined) recordUserPolicyDiagnostic(args.diagnostics);
  const runtimePolicy = resolveRuntimePolicy({
    userPolicy: userPolicy.policy,
    projectPolicy: readValidatedProjectPolicy(args.configDocument),
    projectRoot: args.project.scope === 'project' ? args.project.projectRoot : undefined,
    now: new Date(),
  });
  recordRuntimePolicyDiagnostics(args.diagnostics, runtimePolicy);
  const audit = new PolicyAuditCollector(args.runId);
  if (args.bootstrapPolicyAudit !== undefined) audit.merge(args.bootstrapPolicyAudit);
  enforceDisabledChecksPolicy({
    parentCommand: args.parentCommand,
    policy: runtimePolicy.policy,
    audit,
    toolConfig: args.toolConfig,
    diagnostics: args.diagnostics,
  });
  return { policy: runtimePolicy.policy, audit };
}

function enforceDisabledChecksPolicy(args: {
  readonly parentCommand: string;
  readonly policy: ResolvedTrustPolicy;
  readonly audit: PolicyAuditCollector;
  readonly toolConfig: unknown;
  readonly diagnostics: BootstrapDiagnosticsCollector;
}): void {
  if (args.parentCommand !== 'fit' && args.parentCommand !== 'fitness') return;
  const disabledChecks = configuredDisabledChecks(args.toolConfig);
  if (disabledChecks.length === 0) return;
  const denied: string[] = [];
  for (const slug of disabledChecks) {
    const decision = evaluatePolicyPep({
      policy: args.policy,
      subject: { kind: 'fitness.disabledChecks', id: slug },
      action: 'disable-check',
      evidence: { ci: policyCiEvidenceFromCurrentEnv() },
      audit: args.audit,
    });
    if (!decision.allowed) denied.push(`${slug}: ${decision.decision.reasons.join('; ')}`);
    if (decision.conditioned) {
      args.diagnostics.record({
        severity: 'warning',
        code: 'OPENSIP_POLICY_CONDITIONED',
        category: 'configuration',
        message: `Policy allowed disabled fitness check '${slug}' with conditions.`,
        impact: decision.decision.reasons.join('; '),
        action: 'Review policy exceptions before relying on disabled checks in CI.',
      });
    }
  }
  if (denied.length === 0) return;
  args.diagnostics.record({
    severity: 'error',
    code: 'OPENSIP_POLICY_DENIED',
    category: 'configuration',
    message: 'Policy denied one or more disabled fitness checks.',
    impact: denied.join(' | '),
    action: 'Remove fitness.disabledChecks entries or add explicit policy exceptions.',
  });
  throw new ConfigurationError(`Policy denied fitness.disabledChecks: ${denied.join(' | ')}`, {
    code: POLICY_DENIED.code,
    definition: POLICY_DENIED,
  });
}

function configuredDisabledChecks(toolConfig: unknown): readonly string[] {
  if (!isPlainRecord(toolConfig)) return [];
  const fitness = toolConfig.fitness;
  if (!isPlainRecord(fitness) || !Array.isArray(fitness.disabledChecks)) return [];
  return fitness.disabledChecks.filter((value): value is string => typeof value === 'string');
}

function recordUserPolicyDiagnostic(diagnostics: BootstrapDiagnosticsCollector): void {
  diagnostics.record({
    severity: 'warning',
    code: 'OPENSIP_POLICY_SOURCE_INVALID',
    category: 'configuration',
    message: 'User-level policy could not be parsed.',
    impact: 'The built-in default policy is used for this run until the config is corrected.',
    action: 'Fix ~/.opensip-cli/config.yml#policy.',
  });
}

function recordRuntimePolicyDiagnostics(
  diagnostics: BootstrapDiagnosticsCollector,
  runtimePolicy: ReturnType<typeof resolveRuntimePolicy>,
): void {
  for (const diagnostic of runtimePolicy.diagnostics) {
    diagnostics.record({
      severity:
        runtimePolicy.policy.orgStatus.state === 'required-unavailable' ? 'error' : 'warning',
      code: 'OPENSIP_POLICY_SOURCE_INVALID',
      category: 'configuration',
      message: 'Policy source could not be fully resolved.',
      impact: diagnostic,
      action: 'Fix the policy source or add a valid org policy cache.',
    });
  }
}
