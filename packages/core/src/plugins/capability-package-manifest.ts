import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger } from '../lib/logger.js';

import { isRecord } from './json-guards.js';
import { normalizeResourceRequirements } from './manifest-loader-helpers.js';

import type { ToolResourceRequirement } from '../tools/manifest.js';

/** Package-level capability contribution target metadata from `opensipTools`. */
export interface DeclaredCapabilityPackageMetadata {
  readonly kind?: string;
  readonly targetDomain?: string;
  readonly targetDomainApiVersion?: number;
  readonly requires?: readonly ToolResourceRequirement[];
  readonly requiresInvalid?: boolean;
  readonly manifestHash?: string;
}

interface ParsedPackageJson {
  readonly opensipTools?: unknown;
}

function readPackageJson(packageDir: string): ParsedPackageJson | undefined {
  const pkgJsonPath = join(packageDir, 'package.json');
  if (!existsSync(pkgJsonPath)) return undefined;
  try {
    return JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as ParsedPackageJson;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.debug({
      evt: 'core.marker_discovery.read_failed',
      module: 'core:plugins',
      packageDir,
      error: msg,
    });
    return undefined;
  }
}

function stableManifestHash(block: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(block)).digest('hex')}`;
}

/**
 * Read capability package target/resource metadata from a package's
 * `package.json#opensipTools` block without importing executable package code.
 */
export function readDeclaredCapabilityPackageMetadata(
  packageDir: string,
): DeclaredCapabilityPackageMetadata | undefined {
  const json = readPackageJson(packageDir);
  const block = json?.opensipTools;
  if (!isRecord(block)) return undefined;
  const kind = typeof block.kind === 'string' ? block.kind : undefined;
  const targetDomain = typeof block.targetDomain === 'string' ? block.targetDomain : undefined;
  const targetDomainApiVersion =
    typeof block.targetDomainApiVersion === 'number' ? block.targetDomainApiVersion : undefined;
  const requirements = normalizeResourceRequirements(block.requires);
  const requiresInvalid = block.requires !== undefined && requirements === undefined;
  if (
    kind === undefined &&
    targetDomain === undefined &&
    targetDomainApiVersion === undefined &&
    block.requires === undefined
  ) {
    return undefined;
  }
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(targetDomain === undefined ? {} : { targetDomain }),
    ...(targetDomainApiVersion === undefined ? {} : { targetDomainApiVersion }),
    ...(requirements === undefined || requiresInvalid ? {} : { requires: requirements }),
    ...(requiresInvalid ? { requiresInvalid: true } : {}),
    manifestHash: stableManifestHash(block),
  };
}
