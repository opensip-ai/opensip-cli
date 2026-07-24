/**
 * report-failure — host-owned resolver and fan-out for {@link ReportFailureDetail}
 * (Plan 06). Combines core error types with contracts exit-code policy.
 */

import { mapExitClassToExitCode } from '@opensip-cli/contracts';
import {
  SystemError,
  deepFreeze,
  formatCliDiagnosticHuman,
  normalizeFailure,
  toMachineFailureProjection,
  toPublicFailureProjection,
  toSafeDiagnosticRecord,
  scrubText,
  type CliDiagnostic,
  type DiagnosticsBus,
  type Logger,
  type ReportFailureDetail,
  type ResolvedReportFailure,
} from '@opensip-cli/core';

import type { CommandResult } from '@opensip-cli/contracts';

const DEFAULT_FAILURE_EVT = 'tool.command.failed';
const MODULE_TAG = 'cli:report-failure';
const MAX_DERIVED_ERROR_MESSAGE_LENGTH = 1000;
const DIAGNOSTIC_CATEGORIES = new Set([
  'configuration',
  'compatibility',
  'integrity',
  'runtime',
  'discovery',
  'degraded',
]);

function ownData(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function ownString(value: unknown, key: string): string | undefined {
  const candidate = ownData(value, key);
  return typeof candidate === 'string' ? candidate : undefined;
}

function validExitCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255
    ? value
    : undefined;
}

function safeDiagnostic(raw: unknown): CliDiagnostic | undefined {
  if (raw === undefined) return undefined;
  const record = toSafeDiagnosticRecord(raw);
  const severity = record.severity;
  const category = record.category;
  const code = record.code;
  const message = record.message;
  const impact = record.impact;
  if (
    (severity !== 'error' && severity !== 'warning') ||
    typeof category !== 'string' ||
    !DIAGNOSTIC_CATEGORIES.has(category) ||
    typeof code !== 'string' ||
    typeof message !== 'string' ||
    typeof impact !== 'string'
  ) {
    return undefined;
  }
  const optionalString = (key: string, max: number): string | undefined => {
    const value = record[key];
    return typeof value === 'string' ? scrubText(value, max) : undefined;
  };
  const provenanceRaw = record.provenance;
  const provenance =
    typeof provenanceRaw === 'object' && provenanceRaw !== null && !Array.isArray(provenanceRaw)
      ? toSafeDiagnosticRecord(provenanceRaw)
      : undefined;
  const provenanceString = (key: string): string | undefined => {
    const value = provenance?.[key];
    return typeof value === 'string' ? scrubText(value, 256) : undefined;
  };
  const toolId = provenanceString('toolId');
  const stableId = provenanceString('stableId');
  const packageName = provenanceString('packageName');
  const discoverySource = provenanceString('discoverySource');
  const capabilityDomain = provenanceString('capabilityDomain');
  const safeProvenance = {
    ...(toolId === undefined ? {} : { toolId }),
    ...(stableId === undefined ? {} : { stableId }),
    ...(packageName === undefined ? {} : { packageName }),
    ...(discoverySource === undefined ? {} : { discoverySource }),
    ...(capabilityDomain === undefined ? {} : { capabilityDomain }),
  };
  const action = optionalString('action', 1000);
  const detail = optionalString('detail', 1000);
  const logRef = optionalString('logRef', 256);
  return {
    severity,
    code: scrubText(code, 128),
    category: category as CliDiagnostic['category'],
    message: scrubText(message, 1000),
    impact: scrubText(impact, 1000),
    ...(action === undefined ? {} : { action }),
    ...(detail === undefined ? {} : { detail }),
    ...(logRef === undefined ? {} : { logRef }),
    ...(Object.keys(safeProvenance).length === 0 ? {} : { provenance: safeProvenance }),
  };
}

function safeLogDetail(raw: unknown): ResolvedReportFailure['log'] | undefined {
  const evt = ownString(raw, 'evt');
  if (evt === undefined) return undefined;
  const level = ownData(raw, 'level');
  const data = ownData(raw, 'data');
  return {
    evt: scrubText(evt, 128),
    ...(level === 'warn' || level === 'error' ? { level } : {}),
    ...(data === undefined ? {} : { data: toSafeDiagnosticRecord(data) }),
  };
}

export function truncateDerivedMessage(message: string): string {
  if (message.length <= MAX_DERIVED_ERROR_MESSAGE_LENGTH) return message;
  return `${message.slice(0, MAX_DERIVED_ERROR_MESSAGE_LENGTH - 3)}...`;
}

function deriveErrorDefaults(error: unknown): {
  readonly message?: string;
  readonly exitCode: number;
  readonly code?: string;
  readonly suggestion?: string;
  readonly failure?: Readonly<Record<string, unknown>>;
} {
  // Single normalize path (Plan 00) — definition axes + typed subclass ladder.
  const envelope = normalizeFailure(error);
  const publicProjection = toPublicFailureProjection(envelope);
  return {
    message:
      typeof publicProjection.message === 'string'
        ? truncateDerivedMessage(publicProjection.message)
        : 'The operation failed.',
    exitCode: mapExitClassToExitCode(envelope.definition.exitClass),
    code: envelope.code,
    suggestion: envelope.operatorAction,
    failure: toMachineFailureProjection(envelope),
  };
}

/** Resolve a {@link ReportFailureDetail} into a plain, effect-ready payload. */
function applyErrorDefaults(
  error: unknown,
  fields: {
    message?: string;
    exitCode?: number;
    code?: string;
    suggestion?: string;
    failure?: Readonly<Record<string, unknown>>;
  },
): {
  message?: string;
  exitCode?: number;
  code?: string;
  suggestion?: string;
  failure?: Readonly<Record<string, unknown>>;
} {
  if (error === undefined) return fields;
  const derived = deriveErrorDefaults(error);
  return {
    // Explicit caller overrides win for presentation, but failure projection
    // always preserves the normalized definition axes when an error is present.
    message: fields.message ?? derived.message,
    code: fields.code ?? derived.code,
    exitCode: fields.exitCode ?? derived.exitCode,
    suggestion: fields.suggestion ?? derived.suggestion,
    failure: derived.failure,
  };
}

export function resolveReportFailure(detail: ReportFailureDetail): ResolvedReportFailure {
  const error = ownData(detail, 'error');
  const rawFailure = ownData(detail, 'failure');
  const derived = applyErrorDefaults(error, {
    message: ownString(detail, 'message'),
    exitCode: validExitCode(ownData(detail, 'exitCode')),
    code: ownString(detail, 'code'),
    suggestion: ownString(detail, 'suggestion'),
    ...(rawFailure === undefined ? {} : { failure: toSafeDiagnosticRecord(rawFailure) }),
  });
  const message =
    derived.message === undefined
      ? undefined
      : scrubText(truncateDerivedMessage(derived.message), MAX_DERIVED_ERROR_MESSAGE_LENGTH);
  const exitCode = validExitCode(derived.exitCode);
  const code = derived.code === undefined ? undefined : scrubText(derived.code, 128);

  if (message === undefined || exitCode === undefined) {
    throw new SystemError(
      'reportFailure: message and exitCode are required when no resolvable error is provided',
    );
  }

  const diagnostic = safeDiagnostic(ownData(detail, 'diagnostic'));
  const jsonRequested = ownData(detail, 'jsonRequested');
  const log = safeLogDetail(ownData(detail, 'log'));

  return {
    message,
    exitCode,
    ...(derived.suggestion === undefined
      ? {}
      : { suggestion: scrubText(derived.suggestion, 1000) }),
    ...(code === undefined ? {} : { code }),
    ...(diagnostic === undefined ? {} : { diagnostic }),
    ...(typeof jsonRequested === 'boolean' ? { jsonRequested } : {}),
    ...(log === undefined ? {} : { log }),
    ...(derived.failure === undefined ? {} : { failure: derived.failure }),
  };
}

/** Convert a resolved detail to the wire-safe worker replay shape (no Error instances). */
export function toReportedFailureWire(resolved: ResolvedReportFailure): ResolvedReportFailure {
  return deepFreeze(toSafeDiagnosticRecord(resolved)) as unknown as ResolvedReportFailure;
}

export interface ReportFailureDeps {
  readonly getLogger: () => Logger;
  readonly setExitCode: (code: number) => void;
  readonly render: (result: CommandResult) => Promise<void>;
  readonly emitError: ToolCliContextEmitError;
  readonly writeStderr?: (text: string) => boolean;
  readonly getDiagnostics?: () => DiagnosticsBus | undefined;
}

type ToolCliContextEmitError = (detail: {
  readonly message: string;
  readonly exitCode: number;
  readonly suggestion?: string;
  readonly code?: string;
  readonly failure?: Readonly<Record<string, unknown>>;
  readonly diagnostic?: CliDiagnostic;
}) => void;

/** Build the async {@link ToolCliContext.reportFailure} seam. */
export function createReportFailure(
  deps: ReportFailureDeps,
): (detail: ReportFailureDetail) => Promise<void> {
  const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));

  // eslint-disable-next-line sonarjs/cognitive-complexity -- The host fan-out deliberately isolates each independent sink and preserves three mutually exclusive presentation branches.
  return async (detail: ReportFailureDetail): Promise<void> => {
    const resolved = resolveReportFailure(detail);
    let fallbackWritten = false;
    const reportSecondaryFailure = (): void => {
      if (fallbackWritten) return;
      fallbackWritten = true;
      try {
        writeStderr(
          `opensip: failure reporting degraded [${resolved.code ?? 'UNKNOWN'}]; exit ${String(resolved.exitCode)}\n`,
        );
      } catch {
        // Last-resort reporting must remain total.
      }
    };

    // Exit status is the primary durable effect. Establish it before any
    // logger/renderer that may throw so a secondary sink cannot turn failure
    // into a successful process.
    try {
      deps.setExitCode(resolved.exitCode);
    } catch {
      reportSecondaryFailure();
    }

    const logDetail = resolved.log ?? {
      level: 'warn' as const,
      evt: DEFAULT_FAILURE_EVT,
    };
    const logEntry = {
      evt: logDetail.evt,
      module: MODULE_TAG,
      message: resolved.message,
      exitCode: resolved.exitCode,
      ...(resolved.code === undefined ? {} : { code: resolved.code }),
      ...(logDetail.data === undefined ? {} : { data: logDetail.data }),
    };
    try {
      const log = deps.getLogger();
      if (logDetail.level === 'error') {
        log.error(logEntry);
      } else {
        log.warn(logEntry);
      }
    } catch {
      reportSecondaryFailure();
    }

    try {
      deps.getDiagnostics?.()?.event('execute', 'error', resolved.message);
    } catch {
      reportSecondaryFailure();
    }

    if (resolved.jsonRequested === true) {
      try {
        deps.emitError({
          message: resolved.message,
          exitCode: resolved.exitCode,
          ...(resolved.suggestion === undefined ? {} : { suggestion: resolved.suggestion }),
          ...(resolved.code === undefined ? {} : { code: resolved.code }),
          ...(resolved.failure === undefined ? {} : { failure: resolved.failure }),
          ...(resolved.diagnostic === undefined ? {} : { diagnostic: resolved.diagnostic }),
        });
      } catch {
        reportSecondaryFailure();
      }
      return;
    }

    if (resolved.diagnostic !== undefined) {
      try {
        writeStderr(`${formatCliDiagnosticHuman(resolved.diagnostic)}\n`);
      } catch {
        reportSecondaryFailure();
      }
      return;
    }

    try {
      await deps.render({
        type: 'error',
        message: resolved.message,
        ...(resolved.suggestion === undefined ? {} : { suggestion: resolved.suggestion }),
        exitCode: resolved.exitCode,
      });
    } catch {
      reportSecondaryFailure();
    }
  };
}
