import { isRecord, isStringArray } from './json-guards.js';

import type { ToolCommandManifest } from '../tools/manifest.js';

const COMMAND_OUTPUT_MODES = new Set([
  'signal-envelope',
  'command-result',
  'raw-stream',
  'live-view',
]);
const COMMAND_SCOPE_REQUIREMENTS = new Set(['project', 'none']);

function isRecordArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => isRecord(entry));
}

const COMMAND_SHELL_VALIDATORS: Readonly<Record<string, (value: unknown) => boolean>> = {
  visibility: (value) => value === 'public' || value === 'internal',
  parent: (value) => typeof value === 'string' && value !== '',
  commonFlags: (value) => isStringArray(value),
  options: isRecordArray,
  args: isRecordArray,
  scope: (value) => typeof value === 'string' && COMMAND_SCOPE_REQUIREMENTS.has(value),
  output: (value) => typeof value === 'string' && COMMAND_OUTPUT_MODES.has(value),
  rawStreamReason: (value) => typeof value === 'string',
  producesVerdict: (value) => typeof value === 'boolean',
  producesEvidenceSnapshot: (value) => typeof value === 'boolean',
};

function normalizeCommandShell(
  entry: Record<string, unknown>,
): Partial<ToolCommandManifest> | undefined {
  const shell: Record<string, unknown> = {};
  for (const [field, isValid] of Object.entries(COMMAND_SHELL_VALIDATORS)) {
    const value = entry[field];
    if (value === undefined) continue;
    if (!isValid(value)) return undefined;
    shell[field] = value;
  }
  return shell;
}

export function normalizeCommands(value: unknown): readonly ToolCommandManifest[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const commands: ToolCommandManifest[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    if (typeof entry.name !== 'string' || entry.name === '') return undefined;
    if (typeof entry.description !== 'string') return undefined;
    const { aliases } = entry;
    if (aliases !== undefined && !isStringArray(aliases)) return undefined;
    const shell = normalizeCommandShell(entry);
    if (shell === undefined) return undefined;
    commands.push({
      name: entry.name,
      description: entry.description,
      ...(aliases === undefined ? {} : { aliases }),
      ...shell,
    });
  }
  return commands;
}
