/**
 * report-failure — host-owned resolver and fan-out for {@link ReportFailureDetail}
 * (Plan 06). Combines core error types with contracts exit-code policy.
 */

import { EXIT_CODES, mapToolErrorToExitCode } from '@opensip-cli/contracts';
import {
  SystemError,
  ToolError,
  formatCliDiagnosticHuman,
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

function truncateDerivedMessage(message: string): string {
  if (message.length <= MAX_DERIVED_ERROR_MESSAGE_LENGTH) return message;
  return `${message.slice(0, MAX_DERIVED_ERROR_MESSAGE_LENGTH - 3)}...`;
}

function stringFromUnknown(error: unknown): string {
  try {
    return String(error);
  } catch {
    return '<unstringifiable thrown value>';
  }
}

function deriveErrorDefaults(error: unknown): {
  readonly message?: string;
  readonly exitCode: number;
  readonly code?: string;
} {
  if (error instanceof ToolError) {
    return {
      message: truncateDerivedMessage(error.message),
      exitCode: mapToolErrorToExitCode(error),
      code: error.code,
    };
  }
  if (error instanceof Error) {
    return {
      message: truncateDerivedMessage(error.message),
      exitCode: EXIT_CODES.RUNTIME_ERROR,
    };
  }
  if (error === undefined) {
    return { exitCode: EXIT_CODES.RUNTIME_ERROR };
  }
  return {
    message: truncateDerivedMessage(stringFromUnknown(error)),
    exitCode: EXIT_CODES.RUNTIME_ERROR,
  };
}

/** Resolve a {@link ReportFailureDetail} into a plain, effect-ready payload. */
function applyErrorDefaults(
  detail: ReportFailureDetail,
  fields: { message?: string; exitCode?: number; code?: string },
): { message?: string; exitCode?: number; code?: string } {
  if (detail.error === undefined) return fields;
  const derived = deriveErrorDefaults(detail.error);
  return {
    message: fields.message ?? derived.message,
    code: fields.code ?? derived.code,
    exitCode: fields.exitCode ?? derived.exitCode,
  };
}

export function resolveReportFailure(detail: ReportFailureDetail): ResolvedReportFailure {
  const derived = applyErrorDefaults(detail, {
    message: detail.message,
    exitCode: detail.exitCode,
    code: detail.code,
  });
  const message = derived.message;
  const exitCode = derived.exitCode;
  const code = derived.code;

  if (message === undefined || exitCode === undefined) {
    throw new SystemError(
      'reportFailure: message and exitCode are required when no resolvable error is provided',
    );
  }

  return {
    message,
    exitCode,
    ...(detail.suggestion === undefined ? {} : { suggestion: detail.suggestion }),
    ...(code === undefined ? {} : { code }),
    ...(detail.diagnostic === undefined ? {} : { diagnostic: detail.diagnostic }),
    ...(detail.jsonRequested === undefined ? {} : { jsonRequested: detail.jsonRequested }),
    ...(detail.log === undefined ? {} : { log: detail.log }),
  };
}

/** Convert a resolved detail to the wire-safe worker replay shape (no Error instances). */
export function toReportedFailureWire(resolved: ResolvedReportFailure): ResolvedReportFailure {
  return resolved;
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
  readonly diagnostic?: CliDiagnostic;
}) => void;

/** Build the async {@link ToolCliContext.reportFailure} seam. */
export function createReportFailure(
  deps: ReportFailureDeps,
): (detail: ReportFailureDetail) => Promise<void> {
  const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));

  return async (detail: ReportFailureDetail): Promise<void> => {
    const resolved = resolveReportFailure(detail);
    const log = deps.getLogger();
    const logDetail = resolved.log ?? {
      level: 'warn' as const,
      evt: DEFAULT_FAILURE_EVT,
      data: {
        message: resolved.message,
        ...(resolved.code === undefined ? {} : { code: resolved.code }),
        exitCode: resolved.exitCode,
      },
    };
    const logEntry = {
      evt: logDetail.evt,
      module: MODULE_TAG,
      message: resolved.message,
      exitCode: resolved.exitCode,
      ...(resolved.code === undefined ? {} : { code: resolved.code }),
      ...logDetail.data,
    };
    if (logDetail.level === 'error') {
      log.error(logEntry);
    } else {
      log.warn(logEntry);
    }

    deps.setExitCode(resolved.exitCode);
    deps.getDiagnostics?.()?.event('execute', 'error', resolved.message);

    if (resolved.jsonRequested === true) {
      deps.emitError({
        message: resolved.message,
        exitCode: resolved.exitCode,
        ...(resolved.suggestion === undefined ? {} : { suggestion: resolved.suggestion }),
        ...(resolved.code === undefined ? {} : { code: resolved.code }),
        ...(resolved.diagnostic === undefined ? {} : { diagnostic: resolved.diagnostic }),
      });
      return;
    }

    if (resolved.diagnostic !== undefined) {
      writeStderr(`${formatCliDiagnosticHuman(resolved.diagnostic)}\n`);
      return;
    }

    await deps.render({
      type: 'error',
      message: resolved.message,
      ...(resolved.suggestion === undefined ? {} : { suggestion: resolved.suggestion }),
      exitCode: resolved.exitCode,
    });
  };
}
