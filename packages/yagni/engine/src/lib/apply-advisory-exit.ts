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
  if (current === EXIT_CODES.REPORT_FAILED) return;

  cli.setExitCode(EXIT_CODES.SUCCESS);
}
