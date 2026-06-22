import { EXIT_CODES } from '@opensip-cli/contracts';

import type { YagniConfig } from '../types/yagni-config.js';
import type { ToolCliContext } from '@opensip-cli/core';

/**
 * Re-affirm exit 0 for advisory yagni runs after delivery. Nested graph evidence
 * may have called `setExitCode`; `deliverSignals` only overwrites on run failure.
 */
export function applyAdvisoryExitCode(cli: ToolCliContext, config: YagniConfig): void {
  const failOnErrors = config.failOnErrors ?? 0;
  const failOnWarnings = config.failOnWarnings ?? 0;
  if (failOnErrors > 0 || failOnWarnings > 0) return;

  const current = cli.getExitCode?.();
  if (current === EXIT_CODES.REPORT_FAILED) return;

  cli.setExitCode(EXIT_CODES.SUCCESS);
}
