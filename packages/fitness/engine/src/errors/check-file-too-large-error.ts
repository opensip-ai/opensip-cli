/**
 * Failure funnel for check-pack input files that exceed a check's explicit read bound.
 */

import { ValidationError } from '@opensip-cli/core';

import { fitnessErrorCatalog } from './fitness-error-catalog.js';

const FILE_TOO_LARGE = fitnessErrorCatalog.require('FIT.FITNESS.FILE_TOO_LARGE');

/** Inputs needed to classify an oversized file refusal from a check pack. */
export interface CheckFileTooLargeErrorOptions {
  /** Check slug shown to the adopter whose project is being analyzed. */
  readonly check: string;
  /** Stable branch discriminator retained in the public failure metadata. */
  readonly condition: string;
  /** Input path that the check refused to read. */
  readonly filePath: string;
  /** Observed input size. */
  readonly actualBytes: number;
  /** Maximum size accepted by this check. */
  readonly maxBytes: number;
}

/** Build the catalog-backed failure used when a check refuses an oversized input file. */
export function checkFileTooLargeError({
  check,
  condition,
  filePath,
  actualBytes,
  maxBytes,
}: CheckFileTooLargeErrorOptions): ValidationError {
  return new ValidationError(
    `Check '${check}' cannot analyze '${filePath}': the input is ${actualBytes} bytes, ` +
      `above the ${maxBytes}-byte limit.`,
    {
      code: FILE_TOO_LARGE.code,
      definition: FILE_TOO_LARGE,
      metadata: { actualBytes, condition, maxBytes },
    },
  );
}
