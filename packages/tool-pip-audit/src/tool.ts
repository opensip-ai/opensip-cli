import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigurationError, readPackageVersion } from '@opensip-cli/core';
import { defineExternalToolAdapter, parseFirstSemver, externalToolErrorCatalog  } from '@opensip-cli/external-tool-adapter';

import { parsePipAuditJson } from './parse-pip-audit-json.js';

import type { Tool, ToolIdentity } from '@opensip-cli/core';
import type { AdapterRunContext } from '@opensip-cli/external-tool-adapter';


// Plan 01: registered replacements for `ADAPTER.*` literals that nothing registered.
const CONFIG_REQUIRED = externalToolErrorCatalog.require('EXTERNAL.SCANNER.CONFIG_REQUIRED');

export const PIP_AUDIT_IDENTITY: ToolIdentity = { name: 'pip-audit' };
export const PIP_AUDIT_STABLE_ID = '898272b0-385c-4905-beb9-383de034bfd9';

const REQUIREMENTS_CANDIDATES = [
  'requirements.txt',
  'requirements-dev.txt',
  'requirements.lock',
] as const;

// Upstream pip-audit project-path resolution only accepts pyproject.toml
// (and pylock with --locked). setup.py / setup.cfg are NOT valid project roots.
const PROJECT_MANIFEST_CANDIDATES = ['pyproject.toml'] as const;

function requirementsFile(projectRoot: string): string | undefined {
  for (const name of REQUIREMENTS_CANDIDATES) {
    const fullPath = join(projectRoot, name);
    if (existsSync(fullPath)) return fullPath;
  }
  return undefined;
}

function hasProjectManifest(projectRoot: string): boolean {
  return PROJECT_MANIFEST_CANDIDATES.some((name) => existsSync(join(projectRoot, name)));
}

/**
 * Build the CLI args for a pip-audit run.
 *
 * Target selection (never silently audits the ambient Python env):
 * 1. A requirements file (`-r`) when one is present.
 * 2. Otherwise a project path (positional) when `pyproject.toml` exists —
 *    pip-audit resolves project dependencies from that tree.
 * 3. Otherwise {@link ConfigurationError}: there is no project-scoped dependency
 *    source, and auditing the active environment would be ambient and non-deterministic.
 */
export function buildScanArgs(ctx: AdapterRunContext): readonly string[] {
  const requirements = requirementsFile(ctx.projectRoot);
  let targetArgs: readonly string[];
  if (requirements !== undefined) {
    targetArgs = ['-r', requirements];
  } else if (hasProjectManifest(ctx.projectRoot)) {
    // Positional project_path (not `--path`, which targets a site-packages dir).
    targetArgs = [ctx.projectRoot];
  } else {
    throw new ConfigurationError(
      'pip-audit requires a requirements file (requirements.txt) or a Python project manifest (pyproject.toml).',
      {
        code: CONFIG_REQUIRED.code,
        definition: CONFIG_REQUIRED,
        metadata: { field: 'dependency-source' },
      },
    );
  }
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
  languages: ['python'],
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
