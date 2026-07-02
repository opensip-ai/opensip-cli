import { err, ok, type Result, type Signal, type SignalRepairAction } from '@opensip-cli/core';

import { executeRepairAction } from './actions.js';

import type { RepairBuildInput, RepairError, RepairPlan, SelectedRepairAction } from './types.js';
import type {
  RepairActionRef,
  RepairPreviewResult,
  RepairSessionRef,
  RepairSignalRef,
} from '@opensip-cli/contracts';

function repairError(code: string, message: string): RepairError {
  return { code, message };
}

function signalRef(signal: Signal): RepairSignalRef {
  return {
    id: signal.id,
    ruleId: signal.ruleId,
    message: signal.message,
    ...(signal.filePath === '' ? {} : { filePath: signal.filePath }),
    ...(signal.line === undefined ? {} : { line: signal.line }),
    ...(signal.fingerprint === undefined ? {} : { fingerprint: signal.fingerprint }),
  };
}

function actionRef(action: SignalRepairAction): RepairActionRef {
  return {
    id: action.id,
    kind: action.kind,
    title: action.title,
    autofixable: action.autofixable,
    ...(action.confidence === undefined ? {} : { confidence: action.confidence }),
  };
}

function sessionRef(input: RepairBuildInput['session']): RepairSessionRef {
  return {
    id: input.id,
    tool: input.tool,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  };
}

function selectByIndex(signals: readonly Signal[], raw: string): Result<Signal, RepairError> {
  const index = Number.parseInt(raw, 10);
  if (!Number.isInteger(index) || index < 0 || index.toString() !== raw) {
    return err(
      repairError('invalid-signal-selector', `invalid signal index selector: index:${raw}`),
    );
  }
  const signal = signals[index];
  if (signal === undefined) {
    return err(
      repairError(
        'signal-not-found',
        `signal selector index:${raw} did not match any signal in this session`,
      ),
    );
  }
  return ok(signal);
}

function selectUniqueSignal(
  signals: readonly Signal[],
  selectorKind: 'id' | 'fingerprint',
  selectorValue: string,
): Result<Signal, RepairError> {
  const matches = signals.filter((signal) => signal[selectorKind] === selectorValue);
  if (matches.length === 0) {
    return err(
      repairError(
        'signal-not-found',
        `signal selector ${selectorKind}:${selectorValue} did not match any signal in this session`,
      ),
    );
  }
  if (matches.length > 1) {
    return err(
      repairError(
        'signal-ambiguous',
        `signal selector ${selectorKind}:${selectorValue} matched ${matches.length.toString()} signals`,
      ),
    );
  }
  return ok(matches[0]);
}

export function selectSignal(
  signals: readonly Signal[],
  selector: string,
): Result<Signal, RepairError> {
  const separator = selector.indexOf(':');
  if (separator <= 0) {
    return err(
      repairError(
        'invalid-signal-selector',
        "signal selector must use 'id:<value>', 'fingerprint:<value>', or 'index:<zero-based>'",
      ),
    );
  }
  const kind = selector.slice(0, separator);
  const value = selector.slice(separator + 1);
  if (value === '') {
    return err(repairError('invalid-signal-selector', 'signal selector value cannot be empty'));
  }
  if (kind === 'index') return selectByIndex(signals, value);
  if (kind === 'id' || kind === 'fingerprint') return selectUniqueSignal(signals, kind, value);
  return err(
    repairError(
      'invalid-signal-selector',
      "signal selector must use 'id:<value>', 'fingerprint:<value>', or 'index:<zero-based>'",
    ),
  );
}

export function selectRepairAction(
  signal: Signal,
  actionId?: string,
): Result<SelectedRepairAction, RepairError> {
  const actions = signal.repair?.actions ?? [];
  if (actions.length === 0) {
    return err(
      repairError('repair-unavailable', `signal '${signal.id}' does not include repair actions`),
    );
  }
  if (actionId === undefined) {
    if (actions.length === 1) return ok({ signal, action: actions[0] });
    return err(
      repairError(
        'action-ambiguous',
        `signal '${signal.id}' includes ${actions.length.toString()} repair actions; pass --action`,
      ),
    );
  }
  const action = actions.find((candidate) => candidate.id === actionId);
  if (action === undefined) {
    return err(
      repairError(
        'action-not-found',
        `repair action '${actionId}' was not found on signal '${signal.id}'`,
      ),
    );
  }
  return ok({ signal, action });
}

export function buildRepairPlan(input: RepairBuildInput): Result<RepairPlan, RepairError> {
  const signal = selectSignal(input.signals, input.selector);
  if (!signal.ok) return signal;
  const selected = selectRepairAction(signal.value, input.actionId);
  if (!selected.ok) return selected;
  const details = executeRepairAction({
    projectRoot: input.projectRoot,
    signal: selected.value.signal,
    action: selected.value.action,
  });
  if (!details.ok) return details;

  return ok({
    status: details.value.status,
    session: sessionRef(input.session),
    signal: signalRef(selected.value.signal),
    action: actionRef(selected.value.action),
    changes: details.value.changes,
    ...(details.value.refusal === undefined ? {} : { refusal: details.value.refusal }),
    ...(details.value.verification === undefined
      ? {}
      : { verification: details.value.verification }),
  });
}

export function previewRepair(input: RepairBuildInput): Result<RepairPreviewResult, RepairError> {
  const plan = buildRepairPlan(input);
  if (!plan.ok) return plan;
  return ok({
    type: 'repair-preview',
    status: plan.value.status,
    session: plan.value.session,
    signal: plan.value.signal,
    action: plan.value.action,
    changes: plan.value.changes.map(
      ({ absolutePath: _absolutePath, afterContent: _afterContent, ...change }) => change,
    ),
    ...(plan.value.refusal === undefined ? {} : { refusal: plan.value.refusal }),
    ...(plan.value.verification === undefined ? {} : { verification: plan.value.verification }),
  });
}
