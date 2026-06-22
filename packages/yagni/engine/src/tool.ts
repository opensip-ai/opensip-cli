/**
 * yagniTool — YAGNI reduction audit as a Tool plugin.
 */

import { defineTool, readPackageVersion } from '@opensip-cli/core';

import { yagniFingerprintStrategy } from './baseline-strategy.js';
import { collectYagniReportData } from './cli/report-data.js';
import { yagniCommandSpec } from './cli/yagni-command-spec.js';
import { yagniConfigDeclaration } from './cli/yagni-config-schema.js';

import type { Tool } from '@opensip-cli/core';

export const YAGNI_CONTRACT_VERSION = '1.0.0';

export const YAGNI_STABLE_ID = '3aba9195-2297-4f20-99d5-906945092dfc';

export const yagniTool: Tool = defineTool({
  metadata: {
    id: YAGNI_STABLE_ID,
    name: 'yagni',
    version: readPackageVersion(import.meta.url),
    description: 'YAGNI reduction audit — find speculative surface to remove',
  },
  commandSpecs: [yagniCommandSpec],
  extensionPoints: {
    yagniContractVersion: YAGNI_CONTRACT_VERSION,
    config: yagniConfigDeclaration,
    collectReportData: collectYagniReportData,
    fingerprintStrategy: yagniFingerprintStrategy,
  },
});
