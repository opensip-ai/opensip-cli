import type { CommandResult, SignalEnvelope } from '@opensip-cli/contracts';
import type { ReportFailureDetail } from '@opensip-cli/core';

const COMMAND_RESULT_TYPES = {
  'clear-done': true,
  'config-migrate': true,
  'config-schema': true,
  'config-validate': true,
  'configure-done': true,
  error: true,
  'gate-done': true,
  'graph-impact': true,
  'graph-lookup': true,
  'graph-status': true,
  help: true,
  history: true,
  init: true,
  'list-checks': true,
  'list-recipes': true,
  'plugin-add': true,
  'plugin-list': true,
  'plugin-remove': true,
  'plugin-sync': true,
  'policy-audit': true,
  'policy-explain': true,
  'policy-status': true,
  'policy-trust': true,
  'repair-apply': true,
  'repair-apply-verify': true,
  'repair-preview': true,
  report: true,
  'run-detail': true,
  'run-history': true,
  'run-presentation': true,
  'runtime-status': true,
  'session-replay': true,
  'sim-notice': true,
  'suite-add': true,
  'suite-list': true,
  'suite-run': true,
  'text-lines': true,
  'tools-available': true,
  'tools-create': true,
  'tools-data-purge': true,
  'tools-doctor': true,
  'tools-install': true,
  'tools-list': true,
  'tools-uninstall': true,
  'tools-validate': true,
  'uninstall-done': true,
} satisfies Readonly<Record<CommandResult['type'], true>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @throws {TypeError} When a test assertion receives an incompatible value. */
function fail(message: string): never {
  throw new TypeError(message);
}

export function assertCommandResult(value: unknown): asserts value is CommandResult {
  if (!isRecord(value)) fail('Expected CommandResult object.');
  if (typeof value.type !== 'string' || !Object.hasOwn(COMMAND_RESULT_TYPES, value.type)) {
    fail('Expected CommandResult.type to be a known result discriminator.');
  }
}

export function assertSignalEnvelope(value: unknown): asserts value is SignalEnvelope {
  if (!isRecord(value)) fail('Expected SignalEnvelope object.');
  if (value.schemaVersion !== 2) fail('Expected SignalEnvelope.schemaVersion to be 2.');
  if (typeof value.tool !== 'string' || value.tool.length === 0) {
    fail('Expected SignalEnvelope.tool to be a non-empty string.');
  }
  if (typeof value.runId !== 'string' || value.runId.length === 0) {
    fail('Expected SignalEnvelope.runId to be a non-empty string.');
  }
  if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) {
    fail('Expected SignalEnvelope.createdAt to be a non-empty string.');
  }
  if (!isRecord(value.verdict)) fail('Expected SignalEnvelope.verdict object.');
  if (typeof value.verdict.score !== 'number' || !Number.isFinite(value.verdict.score)) {
    fail('Expected SignalEnvelope.verdict.score to be a finite number.');
  }
  if (typeof value.verdict.passed !== 'boolean') {
    fail('Expected SignalEnvelope.verdict.passed to be a boolean.');
  }
  if (!isRecord(value.verdict.summary)) {
    fail('Expected SignalEnvelope.verdict.summary object.');
  }
  if (!Array.isArray(value.units)) fail('Expected SignalEnvelope.units array.');
  if (!Array.isArray(value.signals)) fail('Expected SignalEnvelope.signals array.');
  if (!isRecord(value.baselineIdentity)) {
    fail('Expected SignalEnvelope.baselineIdentity object.');
  }
  if (
    typeof value.baselineIdentity.fingerprintStrategyId !== 'string' ||
    value.baselineIdentity.fingerprintStrategyId.length === 0 ||
    typeof value.baselineIdentity.fingerprintStrategyVersion !== 'string' ||
    value.baselineIdentity.fingerprintStrategyVersion.length === 0
  ) {
    fail('Expected SignalEnvelope.baselineIdentity to identify a fingerprint strategy.');
  }
}

export function assertReportFailureDetail(value: unknown): ReportFailureDetail {
  if (!isRecord(value)) fail('Expected ReportFailureDetail object.');
  if (value.message !== undefined && typeof value.message !== 'string') {
    fail('Expected ReportFailureDetail.message to be a string when present.');
  }
  if (value.exitCode !== undefined && typeof value.exitCode !== 'number') {
    fail('Expected ReportFailureDetail.exitCode to be a number when present.');
  }
  if (
    typeof value.exitCode === 'number' &&
    (!Number.isFinite(value.exitCode) || !Number.isInteger(value.exitCode))
  ) {
    fail('Expected ReportFailureDetail.exitCode to be a finite integer when present.');
  }
  if (value.jsonRequested !== undefined && typeof value.jsonRequested !== 'boolean') {
    fail('Expected ReportFailureDetail.jsonRequested to be a boolean when present.');
  }
  if (value.suggestion !== undefined && typeof value.suggestion !== 'string') {
    fail('Expected ReportFailureDetail.suggestion to be a string when present.');
  }
  if (value.code !== undefined && typeof value.code !== 'string') {
    fail('Expected ReportFailureDetail.code to be a string when present.');
  }
  if (value.message === undefined && value.error === undefined) {
    fail('Expected ReportFailureDetail.message or error to be present.');
  }
  return value;
}
