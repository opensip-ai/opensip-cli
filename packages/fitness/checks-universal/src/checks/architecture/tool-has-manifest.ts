// @fitness-ignore-file performance-anti-patterns -- the only async op is reading the analyzed workspace's package.json files in parallel; concurrency is bounded by the package.json count (a handful, not attacker-controlled), matching register-tools.ts's identical bounded-IO waiver.
/**
 * @fileoverview Every first-party tool package must declare a conformant
 * static plugin manifest (release 2.9.0, identity & compatibility — Phase 5).
 *
 * Per north-star Principle 6, the guardrail is the definition of done: this
 * check is what prevents the next release from re-accumulating the
 * undeclared-input drift the 2.x ladder paid down. A tool that the host admits through
 * the single compatibility gate (`admitTool` in core) must first be readable
 * as a static `ToolPluginManifest` — `package.json#opensipTools` with
 * `kind:'tool'`, a non-empty `id`, a numeric `apiVersion`, and a non-empty
 * `commands` array of `{ name, description }`. Without a conformant manifest
 * the host cannot inspect the tool's identity + contract epoch BEFORE
 * importing its runtime module, which is the whole point of the manifest.
 *
 * SELF-TARGETING — the check identifies a "first-party tool package" by the
 * marker the manifest itself carries: any `package.json` whose
 * `opensipTools.kind === 'tool'` IS a tool package and therefore must carry a
 * conformant manifest. This is robust (it does not hard-code the three engine
 * paths) and additive-safe (a future fourth tool is covered the moment it
 * declares `kind:'tool'`). It runs over `analyzeAll` so it sees every
 * `package.json` in the scanned set; `node_modules` is excluded by the
 * `configs` target.
 *
 * SCOPE — opensip-tools' own monorepo. The marker (`opensipTools.kind`) is a
 * platform convention, so the check is inert in adopter repos whose packages
 * never declare it (zero `kind:'tool'` package.json → zero findings).
 */
import path from 'node:path';

import { defineCheck, type CheckViolation, type FileAccessor } from '@opensip-tools/fitness';

/** A `commands[]` entry as declared in the static manifest. */
interface ManifestCommand {
  readonly name?: unknown;
  readonly description?: unknown;
}

/** The `opensipTools` manifest block as declared in a tool's `package.json`. */
interface OpensipToolsBlock {
  readonly kind?: unknown;
  readonly id?: unknown;
  readonly apiVersion?: unknown;
  readonly commands?: unknown;
}

interface PackageJson {
  readonly opensipTools?: OpensipToolsBlock;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the identity subset of a single tool package's `opensipTools`
 * block and collect a `CheckViolation` for each missing/invalid field. The
 * field set mirrors the core manifest loader's `validateManifest` so this
 * guardrail and the runtime gate agree on what "conformant" means.
 */
/** Emits a single `manifest-<field>` CheckViolation. */
type PushViolation = (field: string, message: string) => void;

/**
 * Validate the `commands` array (non-empty, each entry a `{ name, description }`
 * record). Split out of {@link checkManifestBlock} so each function stays below
 * the cognitive-complexity ceiling.
 */
function checkCommands(commands: unknown, push: PushViolation): void {
  if (!Array.isArray(commands) || commands.length === 0) {
    push('commands', 'must be a non-empty array of { name, description }');
    return;
  }
  for (const [i, entry] of commands.entries()) {
    if (!isJsonObject(entry)) {
      push('commands', `entry [${i}] must be an object with { name, description }`);
      continue;
    }
    const cmd = entry as ManifestCommand;
    if (typeof cmd.name !== 'string' || cmd.name === '') {
      push('commands', `entry [${i}] is missing a non-empty string "name"`);
    }
    if (typeof cmd.description !== 'string') {
      push('commands', `entry [${i}] is missing a string "description"`);
    }
  }
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
        'A first-party tool must declare a conformant manifest the host can read ' +
        'before importing it: { kind: "tool", id: "<id>", apiVersion: <number>, ' +
        'commands: [{ name, description }, ...] } (release 3.0.0).',
      type: `manifest-${field}`,
    });
  };

  // kind — already 'tool' by selection, but assert explicitly so a future
  // refactor of the selector cannot silently weaken the contract.
  if (block.kind !== 'tool') {
    push('kind', `must be the literal "tool" (got ${JSON.stringify(block.kind)})`);
  }

  if (typeof block.id !== 'string' || block.id === '') {
    push('id', 'must be a non-empty string identifying the tool');
  }

  if (typeof block.apiVersion !== 'number') {
    push('apiVersion', 'must be a number (the plugin-API epoch the tool targets)');
  }

  checkCommands(block.commands, push);

  return violations;
}

/**
 * Pure analysis over a single package.json's parsed content. Returns `[]` for
 * any package that is NOT a tool package (no `opensipTools.kind === 'tool'`),
 * so the check is self-targeting. Exported for unit tests.
 */
export function analyzeToolHasManifest(pkg: PackageJson, filePath: string): CheckViolation[] {
  const block = pkg.opensipTools;
  if (!isJsonObject(block) || block.kind !== 'tool') return [];
  return checkManifestBlock(block, filePath);
}

/**
 * Walk every `package.json` in the scanned set and validate each tool
 * package's manifest. Self-targeting: non-tool packages and non-package.json
 * files contribute nothing. Exported so unit tests can drive it with an
 * in-memory `FileAccessor` without standing up the full Check framework.
 */
export async function analyzeAllToolManifests(files: FileAccessor): Promise<CheckViolation[]> {
  const violations: CheckViolation[] = [];
  // Sequential read over the analyzed workspace's package.json files (bounded by
  // package count); the file-level performance-anti-patterns waiver above covers
  // the await-in-loop — sequential avoids the no-unbounded-concurrency a
  // Promise.all(map) would trip, and the read count is tiny.
  for (const filePath of files.paths) {
    if (path.basename(filePath) !== 'package.json') continue;
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(await files.read(filePath)) as PackageJson;
    } catch {
      // A malformed package.json is some other check's concern; a tool
      // manifest cannot be read from it either way, so skip silently.
      continue;
    }
    violations.push(...analyzeToolHasManifest(pkg, filePath));
  }
  return violations;
}

export const toolHasManifest = defineCheck({
  id: 'f1427a05-0d4d-4ad7-9077-c04292b630dc',
  slug: 'tool-has-manifest',
  description:
    'Every first-party tool package must declare a conformant opensipTools manifest (kind/id/apiVersion/commands) the host can read before import (release 3.0.0)',
  scope: { languages: ['typescript'], concerns: ['config'] },
  tags: ['architecture'],
  contentFilter: 'raw',
  analyzeAll: analyzeAllToolManifests,
});
