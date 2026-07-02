/**
 * yagni-command-spec — declarative primary `yagni` command.
 */

import { buildYagniAnalysisRunCommand } from './yagni-analysis-run.js';

import type { ToolCliContext } from '@opensip-cli/core';

export function buildYagniCommandSpec(setUpLiveView: (cli: ToolCliContext) => void) {
  return buildYagniAnalysisRunCommand(setUpLiveView);
}
