/**
 * yagniTool — YAGNI reduction audit as a Tool plugin.
 */

import { defineTool, readPackageVersion, type ToolCliContext, type Tool } from '@opensip-cli/core';

import { yagniFingerprintStrategy } from './baseline-strategy.js';
import { collectYagniReportData } from './cli/report-data.js';
import { buildYagniCommandSpec } from './cli/yagni-command-spec.js';
import { yagniConfigDeclaration } from './cli/yagni-config-schema.js';
import { renderYagniLive, YAGNI_LIVE_VIEW_KEY, type YagniLiveArgs } from './cli/yagni-runner.js';

export const YAGNI_CONTRACT_VERSION = '1.0.0';

export const YAGNI_STABLE_ID = '3aba9195-2297-4f20-99d5-906945092dfc';

function setUpYagniLiveView(cli: ToolCliContext): void {
  cli.registerLiveView(YAGNI_LIVE_VIEW_KEY, async (args, liveContext) =>
    renderYagniLive(args as YagniLiveArgs, cli, liveContext),
  );
}

export const yagniTool: Tool = defineTool({
  metadata: {
    id: YAGNI_STABLE_ID,
    name: 'yagni',
    version: readPackageVersion(import.meta.url),
    description: 'YAGNI reduction audit — find speculative surface to remove',
  },
  commandSpecs: [buildYagniCommandSpec(setUpYagniLiveView)],
  extensionPoints: {
    yagniContractVersion: YAGNI_CONTRACT_VERSION,
    config: yagniConfigDeclaration,
    collectReportData: collectYagniReportData,
    fingerprintStrategy: yagniFingerprintStrategy,
  },
});
