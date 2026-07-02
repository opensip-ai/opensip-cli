import { writeFileSync } from 'node:fs';

import { err, ok, type Result } from '@opensip-cli/core';

import { ensureRepairWorktreeClean } from './git-safety.js';
import { readSafeTextFile } from './path-safety.js';
import { buildRepairPlan } from './planner.js';

import type { RepairBuildInput, RepairError } from './types.js';
import type { RepairApplyResult } from '@opensip-cli/contracts';

export interface ApplyRepairInput extends RepairBuildInput {
  readonly force: boolean;
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
