import { readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter, parseFirstSemver } from '@opensip-cli/external-tool-adapter';

import { parseGovulncheckJsonLines } from './parse-govulncheck-json-lines.js';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

export const GOVULNCHECK_IDENTITY: ToolIdentity = { name: 'govulncheck' };
export const GOVULNCHECK_STABLE_ID = '13862491-ff5c-412e-b1fa-5a2856c73a4a';

/**
 * Build the CLI args for a govulncheck scan: emit JSON (`-json`) across every
 * package in the current module (`./...`).
 */
export function buildScanArgs(_ctx: AdapterRunContext): readonly string[] {
  return ['-json', './...'];
}

export const tool: Tool = defineExternalToolAdapter({
  identity: GOVULNCHECK_IDENTITY,
  metadata: {
    id: GOVULNCHECK_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'Go vulnerability scanning via govulncheck',
    adapterPackage: '@opensip-cli/tool-govulncheck',
  },
  binary: {
    command: 'govulncheck',
    versionArgs: ['-version'],
    versionParse: (stdout) => parseFirstSemver(stdout) ?? stdout.trim(),
    minVersion: '1.1.0',
    resolution: ['config', 'path'],
    installHint: 'Install govulncheck: https://go.dev/doc/tutorial/govulncheck',
  },
  network: 'networked',
  languages: ['go'],
  commands: [
    {
      name: 'scan',
      description: 'Run govulncheck across Go packages',
      args: buildScanArgs,
      output: { kind: 'stdout', path: 'govulncheck.jsonl' },
      parse: parseGovulncheckJsonLines,
      exitCodes: { ok: [0], findings: [3], errorFrom: 1 },
    },
  ],
  fingerprintStrategy: 'message-hash',
});
