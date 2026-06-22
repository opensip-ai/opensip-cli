import { EXIT_CODES } from '@opensip-cli/contracts';

import type { ToolCliContext } from '@opensip-cli/core';

/**
 * Run `fn` without letting a nested tool handler (e.g. `executeGraph`) leak its
 * exit code into the yagni command. Graph builds evidence only — yagni owns the
 * process exit (advisory `failOnErrors/Warnings: 0`).
 */
export async function withPreservedExitCode<T>(
  cli: ToolCliContext,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = cli.getExitCode?.();
  try {
    return await fn();
  } finally {
    const after = cli.getExitCode?.();
    if (after === prior) {
      // no graph exit leak
    } else if (prior === undefined) {
      if (after !== undefined) {
        cli.setExitCode(EXIT_CODES.SUCCESS);
      }
    } else {
      cli.setExitCode(prior);
    }
  }
}
