/**
 * `policy` subcommand group leaf specs (`status`, `explain`, `audit`).
 */

import {
  grantCapabilityTrust,
  POLICY_ACTIONS,
  parsePolicySubject,
  revokeCapabilityTrust,
  type PolicyAction,
  type PolicyDecision,
  type ResolvedTrustPolicy,
} from '@opensip-cli/config';
import { EXIT_CODES } from '@opensip-cli/contracts';
import {
  currentLogger,
  currentScope,
  readDeclaredCapabilityPackageMetadata,
  resolvePackageDir,
  ValidationError,
} from '@opensip-cli/core';
import {
  PolicyAuditRepo,
  type DataStore,
  type PolicyAuditStoredEvent,
} from '@opensip-cli/datastore';

import { writeArtifactAtomically } from '../bootstrap/atomic-artifact-write.js';
import { flushPolicyAuditEvents } from '../bootstrap/policy-audit-flush.js';
import { policyCiEvidenceFromCurrentEnv } from '../bootstrap/policy-evidence.js';
import {
  evaluatePolicyPep,
  policyAuditFromCurrentScope,
  policyFromCurrentScope,
} from '../bootstrap/policy-pep.js';
import { resolveStateLockPolicy } from '../bootstrap/state-lock-policy.js';

import {
  COMMAND_RESULT,
  defineCommand,
  PROJECT_SCOPE,
  type HostSpec,
} from './host-subcommand-shared.js';

import type { CliCommandsContext } from './shared.js';
import type {
  ErrorResult,
  PolicyAuditResult,
  PolicyAuditRow,
  PolicyDecisionSummary,
  PolicyExplainResult,
  PolicyStatusResult,
  PolicyTrustResult,
} from '@opensip-cli/contracts';

const POLICY_ACTION_CHOICES = [...POLICY_ACTIONS];

function parsePositiveInt(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new ValidationError(`Invalid --limit value: '${raw}'. Must be a positive integer.`);
  }
  return n;
}

function toDecisionSummary(decision: PolicyDecision): PolicyDecisionSummary {
  return {
    outcome: decision.outcome,
    reasons: decision.reasons,
    matchedExceptionIds: decision.matchedExceptionIds,
    sourceTiers: decision.sourceTiers,
  };
}

function buildPolicyStatus(policy: ResolvedTrustPolicy): PolicyStatusResult {
  return {
    type: 'policy-status',
    mode: policy.mode,
    ci: policy.ci,
    orgStatus: policy.orgStatus,
    sources: policy.sourceTiers,
    exceptions: policy.exceptions.map((exception) => ({
      id: exception.id,
      subject: exception.subject,
      action: exception.action,
      expiresAt: exception.expiresAt,
      sourceTier: exception.sourceTier,
    })),
    ...(policy.capabilityGrants.length === 0
      ? {}
      : { capabilityGrants: policy.capabilityGrants }),
  };
}

function executePolicyExplain(
  opts: { readonly subject: string; readonly action: string },
  ctx: CliCommandsContext,
): PolicyExplainResult | { type: 'error'; message: string; exitCode: number } {
  const subject = parsePolicySubject(opts.subject);
  if (subject === undefined) {
    ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
    return {
      type: 'error',
      message: `Invalid policy subject '${opts.subject}'. Expected kind:id.`,
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    };
  }
  if (!POLICY_ACTIONS.includes(opts.action as PolicyAction)) {
    ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
    return {
      type: 'error',
      message: `Invalid policy action '${opts.action}'.`,
      exitCode: EXIT_CODES.CONFIGURATION_ERROR,
    };
  }
  const decision = evaluatePolicyPep({
    policy: policyFromCurrentScope(),
    subject,
    action: opts.action as PolicyAction,
    evidence: { ci: policyCiEvidenceFromCurrentEnv() },
    audit: policyAuditFromCurrentScope(),
  });
  currentLogger().info({
    evt: 'policy.command.explain.complete',
    module: 'cli:policy-command',
    action: opts.action,
    subjectKind: subject.kind,
    outcome: decision.decision.outcome,
  });
  return {
    type: 'policy-explain',
    subject: opts.subject,
    action: opts.action,
    decision: toDecisionSummary(decision.decision),
  };
}

function toAuditRow(event: PolicyAuditStoredEvent): PolicyAuditRow {
  return {
    id: event.id,
    ...(event.runId === undefined ? {} : { runId: event.runId }),
    timestamp: event.timestamp,
    subject: `${event.subjectKind}:${event.subjectId}`,
    subjectKind: event.subjectKind,
    action: event.action,
    outcome:
      event.outcome === 'deny' || event.outcome === 'allow-with-conditions'
        ? event.outcome
        : 'allow',
    reasons: event.reasons,
    matchedExceptionIds: event.matchedExceptionIds,
    sourceTiers: event.sourceTiers,
  };
}

function executePolicyAudit(args: {
  readonly datastore: DataStore;
  readonly limit?: number;
  readonly out?: string;
}): PolicyAuditResult {
  flushPolicyAuditEvents(args.datastore);
  const repo = new PolicyAuditRepo(args.datastore);
  const events = repo.list({ limit: args.limit }).map(toAuditRow);
  const result: PolicyAuditResult = {
    type: 'policy-audit',
    events,
    totalCount: events.length,
    ...(args.out === undefined ? {} : { exportedTo: args.out }),
  };
  if (args.out !== undefined) {
    writeArtifactAtomically(args.out, `${JSON.stringify(result, null, 2)}\n`, {
      policy: resolveStateLockPolicy(),
      logger: currentLogger(),
      runId: currentScope()?.runId,
      command: 'policy audit',
    });
    currentLogger().info({
      evt: 'policy.command.audit.export.complete',
      module: 'cli:policy-command',
      count: events.length,
    });
  }
  return result;
}

/** Exact npm package name (optionally scoped) — rejects path traversal input. */
const NPM_PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u;

function policyTrustError(message: string): ErrorResult {
  return { type: 'error', message, exitCode: EXIT_CODES.CONFIGURATION_ERROR };
}

function recordTrustCeremony(input: {
  readonly action: 'trust' | 'untrust';
  readonly id: string;
  readonly outcome: 'allow' | 'deny';
  readonly reasons: readonly string[];
  readonly manifestHash?: string;
}): void {
  policyAuditFromCurrentScope()?.record({
    occurredAt: new Date().toISOString(),
    action: input.action,
    subject: `capability-pack:${input.id}`,
    outcome: input.outcome,
    sourceTier: 'user',
    reasons: input.reasons,
    exceptionIds: [],
    metadata: input.manifestHash === undefined ? {} : { manifestHash: input.manifestHash },
  });
  currentLogger().info({
    evt: `policy.command.${input.action}.complete`,
    module: 'cli:policy-command',
    packageName: input.id,
    outcome: input.outcome,
  });
}

/**
 * `policy trust <pack>` — the operator ceremony that grants capability-pack
 * trust on the USER-LEVEL global config (the single out-of-repo trust
 * surface). The grant binds the pack's exact id to the provenance (manifest
 * hash) of the artifact resolved HERE, at grant time — admission later
 * requires both to match, so a repo shadowing a trusted name with different
 * code is denied.
 */
function executePolicyTrust(
  packageName: string,
  ctx: CliCommandsContext,
): PolicyTrustResult | ErrorResult {
  if (!NPM_PACKAGE_NAME.test(packageName)) {
    ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
    return policyTrustError(`Invalid package name '${packageName}'.`);
  }
  const projectRoot = currentScope()?.projectContext?.projectRoot;
  if (projectRoot === undefined) {
    ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
    return policyTrustError('policy trust must run inside a project (no project root resolved).');
  }
  const packageDir = resolvePackageDir(projectRoot, packageName);
  if (packageDir === undefined) {
    ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
    recordTrustCeremony({
      action: 'trust',
      id: packageName,
      outcome: 'deny',
      reasons: ['package not resolvable from the project'],
    });
    return policyTrustError(
      `Package '${packageName}' is not resolvable from ${projectRoot} — install it first.`,
    );
  }
  const metadata = readDeclaredCapabilityPackageMetadata(packageDir);
  if (metadata?.manifestHash === undefined) {
    ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
    recordTrustCeremony({
      action: 'trust',
      id: packageName,
      outcome: 'deny',
      reasons: ['package declares no opensipTools capability manifest'],
    });
    return policyTrustError(
      `Package '${packageName}' declares no opensipTools capability manifest — nothing to trust.`,
    );
  }
  grantCapabilityTrust({
    id: packageName,
    manifestHash: metadata.manifestHash,
    grantedAt: new Date().toISOString(),
  });
  recordTrustCeremony({
    action: 'trust',
    id: packageName,
    outcome: 'allow',
    reasons: ['operator granted capability trust'],
    manifestHash: metadata.manifestHash,
  });
  return {
    type: 'policy-trust',
    id: packageName,
    action: 'granted',
    manifestHash: metadata.manifestHash,
  };
}

function executePolicyUntrust(
  packageName: string,
  ctx: CliCommandsContext,
): PolicyTrustResult | ErrorResult {
  if (!NPM_PACKAGE_NAME.test(packageName)) {
    ctx.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
    return policyTrustError(`Invalid package name '${packageName}'.`);
  }
  const removed = revokeCapabilityTrust(packageName);
  recordTrustCeremony({
    action: 'untrust',
    id: packageName,
    outcome: 'allow',
    reasons: [removed ? 'operator revoked capability trust' : 'no grant existed'],
  });
  return { type: 'policy-trust', id: packageName, action: removed ? 'revoked' : 'not-found' };
}

function buildPolicyTrustSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: 'opensip-cli',
      path: 'packages/cli/src/commands/host-subcommand-policy.ts',
      declaration: 'buildPolicyTrustSpec',
    },
    name: 'trust',
    description:
      'Grant operator trust to a capability pack (user-level; binds the resolved provenance)',
    commonFlags: ['json', 'cwd'],
    args: [{ name: 'package', description: 'Exact npm package name of the capability pack' }],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as { _args: string[] };
      return executePolicyTrust(opts._args[0] ?? '', ctx);
    },
  });
}

function buildPolicyUntrustSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: 'opensip-cli',
      path: 'packages/cli/src/commands/host-subcommand-policy.ts',
      declaration: 'buildPolicyUntrustSpec',
    },
    name: 'untrust',
    description: 'Revoke operator trust for a capability pack (user-level)',
    commonFlags: ['json', 'cwd'],
    args: [{ name: 'package', description: 'Exact npm package name of the capability pack' }],
    scope: 'none',
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as { _args: string[] };
      return executePolicyUntrust(opts._args[0] ?? '', ctx);
    },
  });
}

function buildPolicyStatusSpec(): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: 'opensip-cli',
      path: 'packages/cli/src/commands/host-subcommand-policy.ts',
      declaration: 'buildPolicyStatusSpec',
    },
    name: 'status',
    description: 'Show the effective local trust policy',
    commonFlags: ['json', 'cwd'],
    scope: 'none',
    output: COMMAND_RESULT,
    handler: () => buildPolicyStatus(policyFromCurrentScope()),
  });
}

function buildPolicyExplainSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: 'opensip-cli',
      path: 'packages/cli/src/commands/host-subcommand-policy.ts',
      declaration: 'buildPolicyExplainSpec',
    },
    name: 'explain',
    description: 'Explain the policy decision for a subject and action',
    commonFlags: ['json', 'cwd'],
    args: [{ name: 'subject', description: 'Policy subject, for example installed-tool:demo' }],
    options: [
      {
        flag: '--action',
        value: '<name>',
        description: 'Policy action to evaluate',
        choices: POLICY_ACTION_CHOICES,
        default: 'load',
      },
    ],
    scope: 'none',
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as { _args: string[]; action?: string };
      return executePolicyExplain(
        { subject: opts._args[0] ?? '', action: opts.action ?? 'load' },
        ctx,
      );
    },
  });
}

function buildPolicyAuditSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: 'opensip-cli',
      path: 'packages/cli/src/commands/host-subcommand-policy.ts',
      declaration: 'buildPolicyAuditSpec',
    },
    name: 'audit',
    description: 'List or export local trust-policy audit events',
    commonFlags: ['json'],
    options: [
      {
        flag: '--limit',
        value: '<n>',
        description: 'Maximum audit events to return',
        parse: parsePositiveInt,
      },
      {
        flag: '--out',
        value: '<path>',
        description: 'Write the audit result JSON to a file',
      },
    ],
    scope: PROJECT_SCOPE,
    output: COMMAND_RESULT,
    handler: (rawOpts) => {
      const opts = rawOpts as { limit?: number; out?: string };
      return executePolicyAudit({
        datastore: ctx.datastore() as DataStore,
        limit: opts.limit,
        out: opts.out,
      });
    },
  });
}

export function buildPolicyGroupLeaves(ctx: CliCommandsContext): readonly HostSpec[] {
  return [
    buildPolicyStatusSpec(),
    buildPolicyExplainSpec(ctx),
    buildPolicyAuditSpec(ctx),
    buildPolicyTrustSpec(ctx),
    buildPolicyUntrustSpec(ctx),
  ];
}
