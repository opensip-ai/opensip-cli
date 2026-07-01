import { ConfigurationError, type ToolCliContext } from '@opensip-cli/core';

import { EXIT_CODES } from './exit-codes.js';

export interface BaselineExportFailure {
  readonly message: string;
  readonly exitCode: number;
  readonly error: unknown;
}

export interface BaselineExportOptions<TResult> {
  readonly cli: ToolCliContext;
  readonly outPath: string;
  readonly jsonRequested: boolean;
  readonly result: TResult;
  readonly exportArtifact: () => Promise<void>;
  readonly writeText: (outPath: string) => void;
  readonly onFailure?: (failure: BaselineExportFailure) => void;
}

/**
 * Shared control flow for raw-stream baseline export commands.
 *
 * The host-owned baseline seam performs the actual artifact write; this helper
 * only normalizes the common success/failure surface used by tool export
 * subcommands.
 */
export async function runBaselineExport<TResult>(
  options: BaselineExportOptions<TResult>,
): Promise<void> {
  try {
    await options.exportArtifact();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exitCode =
      error instanceof ConfigurationError
        ? EXIT_CODES.CONFIGURATION_ERROR
        : EXIT_CODES.RUNTIME_ERROR;
    options.onFailure?.({ message, exitCode, error });
    await options.cli.reportFailure({
      message,
      exitCode,
      jsonRequested: options.jsonRequested,
    });
    return;
  }

  if (options.jsonRequested) {
    options.cli.emitJson(options.result);
    return;
  }

  options.writeText(options.outPath);
}
