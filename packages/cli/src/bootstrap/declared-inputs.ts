import { readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

import { currentScope, readPackageVersion } from '@opensip-cli/core';

import type { DeclaredInputs, SignalEnvelope } from '@opensip-cli/contracts';
import type { ToolShortId } from '@opensip-cli/core';

interface CollectDeclaredInputsOptions {
  readonly cwd?: string;
  readonly cliVersion?: string;
  readonly nodeVersion?: string;
  readonly platform?: string;
  readonly packageManager?: string;
  readonly env?: Pick<NodeJS.ProcessEnv, 'npm_config_user_agent'>;
  readonly engineVersion?: string;
}

function readPackageManagerFromPackageJson(cwd: string): string | undefined {
  let dir = cwd;
  const { root } = parse(dir);
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        packageManager?: unknown;
      };
      if (typeof pkg.packageManager === 'string' && pkg.packageManager.length > 0) {
        return pkg.packageManager;
      }
    } catch {
      // @swallow-ok absence of a package.json at this level; keep walking upward.
    }
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}

function packageManagerFromUserAgent(userAgent: string | undefined): string | undefined {
  if (userAgent === undefined || userAgent.length === 0) return undefined;
  const first = userAgent.split(' ')[0];
  const match = /^([^/]+)\/([^/]+)/.exec(first ?? '');
  if (!match?.[1] || !match[2]) return first;
  return `${match[1]}@${match[2]}`;
}

function resolvePackageManager(opts: CollectDeclaredInputsOptions): string | undefined {
  if (opts.packageManager !== undefined) return opts.packageManager;
  const fromPackageJson = readPackageManagerFromPackageJson(opts.cwd ?? process.cwd());
  return (
    fromPackageJson ?? packageManagerFromUserAgent((opts.env ?? process.env).npm_config_user_agent)
  );
}

function manifestVersionFor(tool: ToolShortId): string | undefined {
  const manifests = currentScope()?.toolManifests ?? [];
  return manifests.find((manifest) => manifest.id === tool || manifest.identity.name === tool)
    ?.version;
}

export function collectDeclaredInputsForTool(
  tool: ToolShortId,
  opts: CollectDeclaredInputsOptions = {},
): DeclaredInputs {
  return {
    cliVersion: opts.cliVersion ?? readPackageVersion(import.meta.url),
    nodeVersion: opts.nodeVersion ?? process.versions.node,
    packageManager: resolvePackageManager(opts),
    platform: opts.platform ?? `${process.platform}/${process.arch}`,
    tool,
    engineVersion: opts.engineVersion ?? manifestVersionFor(tool),
  };
}

export function collectDeclaredInputs(
  envelope: SignalEnvelope,
  opts: CollectDeclaredInputsOptions = {},
): DeclaredInputs {
  return {
    ...collectDeclaredInputsForTool(envelope.tool, opts),
    baselineIdentity: envelope.baselineIdentity,
  };
}

export function stampDeclaredInputs(
  envelope: SignalEnvelope,
  opts: CollectDeclaredInputsOptions = {},
): SignalEnvelope {
  return {
    ...envelope,
    declaredInputs: envelope.declaredInputs ?? collectDeclaredInputs(envelope, opts),
  };
}
