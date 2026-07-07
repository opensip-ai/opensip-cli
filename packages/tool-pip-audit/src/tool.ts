import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter, parseFirstSemver } from '@opensip-cli/external-tool-adapter';

import { parsePipAuditJson } from './parse-pip-audit-json.js';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';

export const PIP_AUDIT_IDENTITY: ToolIdentity = { name: 'pip-audit' };
export const PIP_AUDIT_STABLE_ID = '898272b0-385c-4905-beb9-383de034bfd9';

function requirementsFile(projectRoot: string): string | undefined {
  for (const name of ['requirements.txt', 'requirements-dev.txt', 'requirements.lock']) {
    const fullPath = join(projectRoot, name);
    if (existsSync(fullPath)) return fullPath;
  }
  return undefined;
}

export function buildScanArgs(ctx: AdapterRunContext): readonly string[] {
  const requirements = requirementsFile(ctx.projectRoot);
  // With a requirements file, audit it. Otherwise audit the ACTIVE Python
  // environment (pip-audit's default with no target). We deliberately do NOT pass
  // `--path <projectRoot>`: `--path` targets an installed environment's
  // site-packages directory, not a project source tree, so pointing it at the repo
  // root either errors or audits the wrong thing.
  const targetArgs = requirements === undefined ? [] : ['-r', requirements];
  return [
    ...targetArgs,
    '--format',
    'json',
    '--output',
    ctx.artifactPath('pip-audit.json'),
    '--progress-spinner',
    'off',
  ];
}

export const tool: Tool = defineExternalToolAdapter({
  identity: PIP_AUDIT_IDENTITY,
  metadata: {
    id: PIP_AUDIT_STABLE_ID,
    version: readPackageVersion(import.meta.url),
    description: 'Python dependency vulnerability auditing via pip-audit',
    adapterPackage: '@opensip-cli/tool-pip-audit',
  },
  binary: {
    command: 'pip-audit',
    versionArgs: ['--version'],
    versionParse: (stdout) => parseFirstSemver(stdout) ?? stdout.trim(),
    minVersion: '2.7.0',
    resolution: ['config', 'path'],
    installHint: 'Install pip-audit: https://pypi.org/project/pip-audit/',
  },
  network: 'networked',
  commands: [
    {
      name: 'scan',
      description: 'Audit Python dependencies for known vulnerabilities',
      args: buildScanArgs,
      output: { kind: 'json', path: 'pip-audit.json' },
      parse: parsePipAuditJson,
      exitCodes: { ok: [0], findings: [1], errorFrom: 2 },
    },
  ],
  fingerprintStrategy: 'message-hash',
});
