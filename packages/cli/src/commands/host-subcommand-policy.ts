/**
 * `policy` subcommand group leaf specs (`status`, `explain`, `audit`).
 */

import {
  POLICY_ACTIONS,
  parsePolicySubject,
  type PolicyAction,
  type PolicyDecision,
  type ResolvedTrustPolicy,
} from '@opensip-cli/config';
import { EXIT_CODES } from '@opensip-cli/contracts';
import { currentLogger, currentScope, ValidationError } from '@opensip-cli/core';
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
import { executePolicyTrust, executePolicyUntrust } from './policy-trust-ceremony.js';

import type { CliCommandsContext } from './shared.js';
import type {
  PolicyAuditResult,
  PolicyAuditRow,
  PolicyDecisionSummary,
  PolicyExplainResult,
  PolicyStatusResult,
} from '@opensip-cli/contracts';

const POLICY_ACTION_CHOICES = [...POLICY_ACTIONS];
const POLICY_HANDLER_PACKAGE = 'opensip-cli';
const POLICY_HANDLER_PATH = 'packages/cli/src/commands/host-subcommand-policy.ts';
const DECIMAL_INTEGER = /^\d+$/u;

function parsePositiveInt(raw: string): number {
  const n = DECIMAL_INTEGER.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n <= 0) {
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
    ...(policy.capabilityGrants.length === 0 ? {} : { capabilityGrants: policy.capabilityGrants }),
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

function buildPolicyTrustSpec(ctx: CliCommandsContext): HostSpec {
  return defineCommand<unknown, CliCommandsContext>({
    staticHandler: {
      package: POLICY_HANDLER_PACKAGE,
      path: POLICY_HANDLER_PATH,
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
      package: POLICY_HANDLER_PACKAGE,
      path: POLICY_HANDLER_PATH,
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
      package: POLICY_HANDLER_PACKAGE,
      path: POLICY_HANDLER_PATH,
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
      package: POLICY_HANDLER_PACKAGE,
      path: POLICY_HANDLER_PATH,
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
      package: POLICY_HANDLER_PACKAGE,
      path: POLICY_HANDLER_PATH,
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
