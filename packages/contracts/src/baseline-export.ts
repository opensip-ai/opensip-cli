import { ConfigurationError, type ToolCliContext } from '@opensip-cli/core';

import { EXIT_CODES } from './exit-codes.js';

/** Normalized failure detail surfaced when a baseline export artifact write fails. */
export interface BaselineExportFailure {
  /** Human-readable failure message (the underlying error's message). */
  readonly message: string;
  /** Process exit code the host should apply for this failure. */
  readonly exitCode: number;
  /** The original thrown value, preserved for logging/diagnostics. */
  readonly error: unknown;
}

/** Inputs describing a single raw-stream baseline export command run. */
export interface BaselineExportOptions<TResult> {
  /** The tool CLI context providing the documented output/delivery seams. */
  readonly cli: ToolCliContext;
  /** Destination path the baseline artifact is written to. */
  readonly outPath: string;
  /** Whether the caller requested machine (`--json`) output. */
  readonly jsonRequested: boolean;
  /** The structured result emitted on the `--json` success path. */
  readonly result: TResult;
  /** Performs the host-owned artifact write; may reject to signal failure. */
  readonly exportArtifact: () => Promise<void>;
  /** Synchronously writes the human-readable confirmation status line. */
  readonly writeTextSync: (outPath: string) => void;
  /** Optional hook invoked with normalized detail before the failure is reported. */
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

  options.writeTextSync(options.outPath);
}
