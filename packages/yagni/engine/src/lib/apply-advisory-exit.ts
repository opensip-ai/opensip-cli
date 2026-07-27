import { EXIT_CODES } from '@opensip-cli/contracts';

import type { YagniConfig } from '../types/yagni-config.js';
import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { ToolCliContext } from '@opensip-cli/core';

/**
 * Re-affirm exit 0 for advisory yagni runs after delivery. Nested graph evidence
 * may have called `setExitCode`; `deliverSignals` only overwrites on run failure.
 *
 * Advisory posture covers FINDINGS only. A faulted run (crashed detector —
 * `envelope.verdict.faulted`) is a runtime failure, not an advisory outcome:
 * its RUNTIME_ERROR exit must survive, or a detector crash reads as a clean
 * pass. REPORT_FAILED is likewise preserved.
 */
export function applyAdvisoryExitCode(
  cli: ToolCliContext,
  config: YagniConfig,
  envelope: SignalEnvelope,
): void {
  const failOnErrors = config.failOnErrors ?? 0;
  const failOnWarnings = config.failOnWarnings ?? 0;
  if (failOnErrors > 0 || failOnWarnings > 0) return;

  if (envelope.verdict.faulted === true) return;

  const current = cli.getExitCode?.();
  // The interrupt coordinator writes process.exitCode directly, so the tool
  // context may still look unset. Advisory posture may erase findings-only
  // runtime exit 1; it must never erase cancellation or other command failures.
  if (current === EXIT_CODES.CANCELLED || process.exitCode === EXIT_CODES.CANCELLED) return;
  if (
    current !== undefined &&
    current !== EXIT_CODES.SUCCESS &&
    current !== EXIT_CODES.RUNTIME_ERROR
  ) {
    return;
  }

  cli.setExitCode(EXIT_CODES.SUCCESS);
}
