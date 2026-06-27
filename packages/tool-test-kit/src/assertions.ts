import type { CommandResult, SignalEnvelope } from '@opensip-cli/contracts';
import type { ReportFailureDetail } from '@opensip-cli/core';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @throws {TypeError} When a test assertion receives an incompatible value. */
function fail(message: string): never {
  throw new TypeError(message);
}

export function assertCommandResult(value: unknown): asserts value is CommandResult {
  if (!isRecord(value)) fail('Expected CommandResult object.');
  if (typeof value.type !== 'string' || value.type.length === 0) {
    fail('Expected CommandResult.type to be a non-empty string.');
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
  if (!isRecord(value.verdict)) fail('Expected SignalEnvelope.verdict object.');
  if (!Array.isArray(value.units)) fail('Expected SignalEnvelope.units array.');
  if (!Array.isArray(value.signals)) fail('Expected SignalEnvelope.signals array.');
}

export function assertReportFailureDetail(value: unknown): asserts value is ReportFailureDetail {
  if (!isRecord(value)) fail('Expected ReportFailureDetail object.');
  if (value.message !== undefined && typeof value.message !== 'string') {
    fail('Expected ReportFailureDetail.message to be a string when present.');
  }
  if (value.exitCode !== undefined && typeof value.exitCode !== 'number') {
    fail('Expected ReportFailureDetail.exitCode to be a number when present.');
  }
  if (value.jsonRequested !== undefined && typeof value.jsonRequested !== 'boolean') {
    fail('Expected ReportFailureDetail.jsonRequested to be a boolean when present.');
  }
}
