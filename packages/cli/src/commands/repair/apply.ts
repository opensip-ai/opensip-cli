import { writeFileSync } from 'node:fs';

import { err, ok, type Result } from '@opensip-cli/core';

import { changedFilesForRepair } from './changes.js';
import { ensureRepairWorktreeClean } from './git-safety.js';
import { readSafeTextFile } from './path-safety.js';
import { buildRepairPlan } from './planner.js';
import { verifyRepair, type ProcessRunner, type VerifyRepairInput } from './verify-runner.js';
import { skippedVerification } from './verify.js';

import type { RepairBuildInput, RepairError } from './types.js';
import type {
  RepairApplyResult,
  RepairApplyVerifyResult,
  RepairVerificationResult,
} from '@opensip-cli/contracts';

export interface ApplyRepairInput extends RepairBuildInput {
  readonly force: boolean;
}

export type RepairVerifier = (input: VerifyRepairInput) => Promise<RepairVerificationResult>;

export interface ApplyAndVerifyRepairInput extends ApplyRepairInput {
  readonly verifier?: RepairVerifier;
  readonly verificationRunner?: ProcessRunner;
  readonly cliEntrypoint?: string;
  readonly timeoutMs?: number;
}

function repairError(code: string, message: string): RepairError {
  return { code, message };
}

function toApplyResult(
  plan: ReturnType<typeof buildRepairPlan> extends Result<infer T, RepairError> ? T : never,
  status: RepairApplyResult['status'],
): RepairApplyResult {
  return {
    type: 'repair-apply',
    status,
    session: plan.session,
    signal: plan.signal,
    action: plan.action,
    changes: plan.changes.map(
      ({ absolutePath: _absolutePath, afterContent: _afterContent, ...change }) => change,
    ),
    ...(plan.refusal === undefined ? {} : { refusal: plan.refusal }),
    ...(plan.verification === undefined ? {} : { verification: plan.verification }),
  };
}

export function applyRepair(input: ApplyRepairInput): Result<RepairApplyResult, RepairError> {
  const plan = buildRepairPlan(input);
  if (!plan.ok) return plan;
  if (plan.value.status === 'refused') return ok(toApplyResult(plan.value, 'refused'));
  if (plan.value.status === 'already-applied')
    return ok(toApplyResult(plan.value, 'already-applied'));

  const modified = plan.value.changes.filter((change) => change.status === 'modified');
  const clean = ensureRepairWorktreeClean(
    input.projectRoot,
    modified.map((change) => change.filePath),
    input.force,
  );
  if (!clean.ok) return clean;

  for (const change of modified) {
    const current = readSafeTextFile(input.projectRoot, change.filePath);
    if (!current.ok) return current;
    if (current.value.hash !== change.beforeHash) {
      return err(
        repairError(
          'stale-file',
          `repair target changed since preview planning: ${change.filePath}`,
        ),
      );
    }
  }

  for (const change of modified) {
    writeFileSync(change.absolutePath, change.afterContent, 'utf8');
  }

  return ok(toApplyResult(plan.value, 'applied'));
}

function toApplyVerifyResult(
  applyResult: RepairApplyResult,
  verification: RepairVerificationResult,
  force: boolean,
): RepairApplyVerifyResult {
  return {
    type: 'repair-apply-verify',
    status: applyResult.status,
    session: applyResult.session,
    signal: applyResult.signal,
    action: applyResult.action,
    changes: applyResult.changes,
    force,
    ...(applyResult.refusal === undefined ? {} : { refusal: applyResult.refusal }),
    ...(applyResult.verification === undefined
      ? {}
      : { verificationGuidance: applyResult.verification }),
    verification,
  };
}

export async function applyAndVerifyRepair(
  input: ApplyAndVerifyRepairInput,
): Promise<Result<RepairApplyVerifyResult, RepairError>> {
  const applied = applyRepair(input);
  if (!applied.ok) return applied;

  if (applied.value.status === 'refused') {
    return ok(
      toApplyVerifyResult(
        applied.value,
        skippedVerification({
          tool: applied.value.session.tool,
          ruleId: applied.value.signal.ruleId,
          files: changedFilesForRepair(applied.value),
          failure:
            applied.value.refusal === undefined
              ? undefined
              : { code: applied.value.refusal.code, message: applied.value.refusal.message },
        }),
        input.force,
      ),
    );
  }

  const verifier = input.verifier ?? verifyRepair;
  const verification = await verifier({
    projectRoot: input.projectRoot,
    applyResult: applied.value,
    ...(input.verificationRunner === undefined ? {} : { runner: input.verificationRunner }),
    ...(input.cliEntrypoint === undefined ? {} : { cliEntrypoint: input.cliEntrypoint }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  return ok(toApplyVerifyResult(applied.value, verification, input.force));
}
