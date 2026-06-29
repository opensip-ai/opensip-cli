/**
 * CLEAN fixture for `adapter-must-use-substrate`: an adapter authored through the
 * substrate. No child_process import, no execFile/spawn call, no raw defineTool.
 *
 * Note the comment mention of `execFile` below — the check ignores it because it
 * is not a call (`execFile(`), proving the paren-required pattern avoids the
 * false positive the three real adapters would otherwise trip.
 */
import { readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter } from '@opensip-cli/external-tool-adapter';

import { parseGitleaksJson } from './parse-gitleaks-json.js';

import type { Tool } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

// The substrate runs the binary via execFile (no shell) — this adapter never does.
export const tool: Tool = defineExternalToolAdapter({
  identity: { name: 'gitleaks', aliases: ['secrets'] },
  metadata: {
    id: 'cd08f737-ce8e-4813-9259-b4ffeb954268',
    version: readPackageVersion(import.meta.url),
    description: 'Secret scanning via Gitleaks',
    adapterPackage: '@opensip-cli/tool-gitleaks',
  },
  binary: { command: 'gitleaks', versionArgs: ['version'], resolution: ['config', 'path'] },
  network: 'local-only',
  commands: [
    {
      name: 'scan',
      description: 'Scan the project working tree for committed secrets',
      args: (ctx: AdapterRunContext) => ['detect', '--source', ctx.projectRoot],
      output: { kind: 'json', path: 'gitleaks.json' },
      exitCodes: { ok: [0], findings: [1], errorFrom: 2 },
      parse: parseGitleaksJson,
    },
  ],
  fingerprintStrategy: 'message-hash',
});
