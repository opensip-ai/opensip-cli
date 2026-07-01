/**
 * yagniTool — YAGNI reduction audit as a Tool plugin.
 */

import { defineTool, readPackageVersion, type ToolCliContext, type Tool } from '@opensip-cli/core';

import { yagniFingerprintStrategy } from './baseline-strategy.js';
import { collectYagniReportData } from './cli/report-data.js';
import { buildYagniCommandSpec } from './cli/yagni-command-spec.js';
import { yagniConfigDeclaration } from './cli/yagni-config-schema.js';
import { renderYagniLive, type YagniLiveArgs } from './cli/yagni-runner.js';
import { yagniRunWorkerCommandSpec } from './cli/yagni-worker.js';
import { YAGNI_IDENTITY, YAGNI_LIVE_VIEW_KEY } from './identity.js';
import { yagniReplayFromSession } from './persistence/session-replay.js';

/**
 * Per-tool contract version (ADR-0047).
 */
export const YAGNI_CONTRACT_VERSION = '1.0.0';

export const YAGNI_STABLE_ID = '3aba9195-2297-4f20-99d5-906945092dfc';

function setUpYagniLiveView(cli: ToolCliContext): void {
  cli.registerLiveView(YAGNI_LIVE_VIEW_KEY, async (args, liveContext) =>
    renderYagniLive(args as YagniLiveArgs, cli, liveContext),
  );
}

export const yagniTool: Tool = defineTool({
  identity: YAGNI_IDENTITY,
  metadata: {
    id: YAGNI_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'YAGNI reduction audit — find speculative surface to remove',
  },
  commandSpecs: [buildYagniCommandSpec(setUpYagniLiveView), yagniRunWorkerCommandSpec],
  extensionPoints: {
    contractVersions: {
      yagni: YAGNI_CONTRACT_VERSION,
    },
    config: {
      schema: yagniConfigDeclaration.schema,
      defaults: yagniConfigDeclaration.defaults,
      env: yagniConfigDeclaration.env,
    },
    collectReportData: collectYagniReportData,
    sessionReplay: {
      replaySession: yagniReplayFromSession,
    },
    fingerprintStrategy: yagniFingerprintStrategy,
  },
});
