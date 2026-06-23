// @fitness-ignore-file performance-anti-patterns -- bounded parallel package.json reads; same waiver as tool-has-manifest.
/**
 * @fileoverview First-party tool packages must declare a single `identity` block
 * in package.json#opensipTools that matches the normalized runtime surface.
 */
import path from 'node:path';

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-cli/fitness';

interface ManifestIdentity {
  readonly name?: unknown;
  readonly aliases?: unknown;
  readonly layoutKey?: unknown;
}

interface ManifestCommand {
  readonly name?: unknown;
  readonly aliases?: unknown;
  readonly parent?: unknown;
}

interface OpensipToolsBlock {
  readonly kind?: unknown;
  readonly id?: unknown;
  readonly identity?: ManifestIdentity;
  readonly commands?: unknown;
  readonly pluginLayout?: { readonly domain?: unknown };
}

interface PackageJson {
  readonly opensipTools?: OpensipToolsBlock;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type PushViolation = (field: string, message: string) => void;

function checkIdentity(block: OpensipToolsBlock, push: PushViolation): void {
  const identity = block.identity;
  if (!isJsonObject(identity)) {
    push('identity', 'must declare opensipTools.identity { name, aliases?, layoutKey? }');
    return;
  }
  if (typeof identity.name !== 'string' || identity.name === '') {
    push('identity.name', 'must be a non-empty string (canonical CLI + config namespace)');
  }
  if (block.id !== identity.name) {
    push('id', `must equal identity.name (got id=${JSON.stringify(block.id)}, identity.name=${JSON.stringify(identity.name)})`);
  }
}

function findPrimaryCommand(commands: readonly unknown[]): ManifestCommand | undefined {
  for (const entry of commands) {
    if (!isJsonObject(entry)) continue;
    const cmd = entry as ManifestCommand;
    if (cmd.parent === undefined) return cmd;
  }
  return undefined;
}

function checkPrimaryCommandName(
  primary: ManifestCommand,
  identityName: string,
  push: PushViolation,
): void {
  if (primary.name === identityName) return;
  push(
    'commands',
    `primary command name must be identity.name (${JSON.stringify(identityName)}), got ${JSON.stringify(primary.name)}`,
  );
}

function checkPrimaryCommandAliases(
  primary: ManifestCommand,
  identity: ManifestIdentity,
  push: PushViolation,
): void {
  const expectedAliases = Array.isArray(identity.aliases) ? identity.aliases : [];
  const declaredAliases = Array.isArray(primary.aliases) ? primary.aliases : [];
  if (JSON.stringify(declaredAliases) === JSON.stringify(expectedAliases)) return;
  push('commands', 'primary command aliases must equal identity.aliases exactly');
}

function layoutKeyForIdentity(identity: ManifestIdentity, identityName: string): string {
  return typeof identity.layoutKey === 'string' && identity.layoutKey !== ''
    ? identity.layoutKey
    : identityName;
}

function checkPluginLayoutDomain(
  block: OpensipToolsBlock,
  layoutKey: string,
  push: PushViolation,
): void {
  const pluginDomain = block.pluginLayout?.domain;
  if (pluginDomain === undefined || pluginDomain === layoutKey) return;
  push(
    'pluginLayout.domain',
    `must equal identity.layoutKey ?? identity.name (${JSON.stringify(layoutKey)})`,
  );
}

function checkManifestCommands(
  block: OpensipToolsBlock,
  push: PushViolation,
): void {
  const identity = block.identity;
  if (!isJsonObject(identity)) return;
  const identityName = identity.name;
  if (typeof identityName !== 'string') return;

  const commands = block.commands;
  if (!Array.isArray(commands)) return;

  const primary = findPrimaryCommand(commands);

  if (primary === undefined) {
    push('commands', 'must declare exactly one flat primary command matching identity.name');
    return;
  }
  checkPrimaryCommandName(primary, identityName, push);
  checkPrimaryCommandAliases(primary, identity, push);
  checkPluginLayoutDomain(block, layoutKeyForIdentity(identity, identityName), push);
}

function checkManifestBlock(block: OpensipToolsBlock, filePath: string): CheckViolation[] {
  const violations: CheckViolation[] = [];
  const relPath = path.relative(process.cwd(), filePath);
  const push: PushViolation = (field, message) => {
    violations.push({
      line: 1,
      filePath,
      message: `${relPath}: opensipTools.${field} — ${message}`,
      severity: 'error',
      suggestion:
        'Declare tool identity once: opensipTools.identity { name, aliases?, layoutKey? }; ' +
        'id must equal identity.name; primary command name/aliases and pluginLayout.domain must derive from it.',
      type: `identity-${field.replaceAll('.', '-')}`,
    });
  };

  if (block.kind !== 'tool') return violations;
  checkIdentity(block, push);
  checkManifestCommands(block, push);
  return violations;
}

export function analyzeToolIdentitySingleSource(
  pkg: PackageJson,
  filePath: string,
): CheckViolation[] {
  const block = pkg.opensipTools;
  if (!isJsonObject(block) || block.kind !== 'tool') return [];
  return checkManifestBlock(block, filePath);
}

export async function analyzeAllToolIdentityManifests(
  files: FileAccessor,
): Promise<CheckViolation[]> {
  const violations: CheckViolation[] = [];
  for (const filePath of files.paths) {
    if (path.basename(filePath) !== 'package.json') continue;
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(await files.read(filePath)) as PackageJson;
    } catch {
      continue;
    }
    violations.push(...analyzeToolIdentitySingleSource(pkg, filePath));
  }
  return violations;
}

export const toolIdentitySingleSource = defineCheck({
  id: 'c8f3e1a2-9b4d-4e6f-a1c0-2d8e7f9a3b5c',
  slug: 'tool-identity-single-source',
  description:
    'Tool packages declare opensipTools.identity once; manifest id, primary command, aliases, and pluginLayout.domain must match the normalized runtime surface',
  scope: { languages: ['typescript'], concerns: ['config'] },
  tags: ['architecture'],
  contentFilter: 'raw',
  analyzeAll: analyzeAllToolIdentityManifests,
});
