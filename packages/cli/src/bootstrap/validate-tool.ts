/**
 * Runtime shape validation for third-party `tool` exports — the
 * untrusted boundary where `discoverAndRegisterToolPackages` imports
 * an arbitrary npm package and inspects whatever it exports.
 *
 * Verifies the minimal contract the registry depends on: a
 * `metadata.id` string (used for dedupe + listing), a `commands` array,
 * and a command surface — a non-empty `commandSpecs` array (the one command
 * surface as of launch; `register()` was removed). A tool with no `commandSpecs`
 * cannot mount any command, so it fails the shape check. `initialize` and
 * `contributeScope` stay optional per the Tool interface.
 *
 * Ordering vs. the admission gate: this shape check runs AFTER a
 * tool's module is imported. The compatibility gate (`admitTool`) and the
 * project-local TRUST gate (`admitProjectLocalTool`, deny-by-default) run
 * on the STATIC manifest *before* import — so a project-local executable
 * tool that is not allowlisted is fail-closed without its code ever running,
 * and never reaches `isValidTool`.
 */

import { validateCommandSpec, type Tool } from '@opensip-cli/core';

export function isValidTool(value: unknown): value is Tool {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    metadata?: unknown;
    commandSpecs?: unknown;
    commands?: unknown;
  };
  if (typeof candidate.metadata !== 'object' || candidate.metadata === null) return false;
  if (typeof (candidate.metadata as { id?: unknown }).id !== 'string') return false;
  if (!Array.isArray(candidate.commands)) return false;
  // A tool must expose a command surface: a non-empty declarative `commandSpecs`
  // array (the one command surface, launch — `register()` was removed). A tool
  // with no commandSpecs cannot contribute any command and is rejected.
  if (!Array.isArray(candidate.commandSpecs) || candidate.commandSpecs.length === 0) return false;
  for (const spec of candidate.commandSpecs) {
    if (!validateCommandSpec(spec)) return false;
  }
  return true;
}
