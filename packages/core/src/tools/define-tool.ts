/**
 * Author-facing entry point for Tool plugins. Authors declare `identity` and
 * `commandSpecs`; {@link defineTool} derives metadata, commands, config namespace,
 * plugin layout domain, and session replay discriminant.
 */

import { ValidationError } from '../lib/errors.js';

import {
  isNestedCommandDraft,
  isPrimaryCommandDraft,
  NESTED_COMMAND_DRAFT,
  PRIMARY_COMMAND_DRAFT,
  type NestedCommandSpecDraft,
  type PrimaryCommandSpecDraft,
  type ToolCommandSpecInput,
} from './command-spec-draft.js';
import { assertCommandSpec } from './command-spec-validate.js';
import { deriveCommandsFromSpecs } from './derive-commands-from-specs.js';
import { validateToolIdentity } from './identity.js';

import type { ToolConfigContribution } from './capability.js';
import type { CommandSpec } from './command-spec.js';
import type { ToolIdentity } from './identity.js';
import type { ToolSessionReplayContribution } from './tool-sessions.js';
import type { ToolCliContext, Tool, ToolExtensionPoints, ToolMetadata } from './types.js';
import type { PluginLayout } from '../plugins/types.js';

/** Input to {@link defineTool} — the small author surface. */
export interface DefineToolInput {
  readonly metadata: Omit<ToolMetadata, 'name'>;
  readonly identity: ToolIdentity;
  readonly commandSpecs: readonly ToolCommandSpecInput<unknown, ToolCliContext>[];
  readonly extensionPoints?: Omit<ToolExtensionPoints, 'config' | 'sessionReplay'> & {
    readonly config?: Omit<ToolConfigContribution, 'namespace'>;
    readonly sessionReplay?: Omit<ToolSessionReplayContribution, 'tool'>;
  };
  readonly pluginLayout?: Omit<PluginLayout, 'domain'> & { readonly domain?: never };
  readonly contractVersion?: string;
}

function aliasesEqual(a: readonly string[] | undefined, b: readonly string[]): boolean {
  const left = a ?? [];
  if (left.length !== b.length) return false;
  return left.every((value, index) => value === b[index]);
}

function normalizeCommandSpecs(
  specs: readonly ToolCommandSpecInput<unknown, ToolCliContext>[],
  identity: ReturnType<typeof validateToolIdentity>,
): readonly CommandSpec<unknown, ToolCliContext>[] {
  const normalized: CommandSpec<unknown, ToolCliContext>[] = [];
  let primaryCount = 0;

  for (const spec of specs) {
    if (isPrimaryCommandDraft(spec)) {
      const primary: CommandSpec<unknown, ToolCliContext> = {
        ...stripPrimaryDraftMarker(spec),
        name: identity.name,
        aliases: [...identity.aliases],
      };
      assertCommandSpec(primary);
      normalized.push(primary);
      primaryCount += 1;
      continue;
    }

    if (isNestedCommandDraft(spec)) {
      const nested: CommandSpec<unknown, ToolCliContext> = {
        ...stripNestedDraftMarker(spec),
        parent: identity.name,
      };
      assertCommandSpec(nested);
      normalized.push(nested);
      continue;
    }

    const named = spec;
    if (named.parent !== undefined && named.parent !== identity.name) {
      throw new ValidationError(
        `Command '${named.name}' declares parent '${named.parent}' but tool identity name is '${identity.name}'.`,
        { code: 'TOOL.IDENTITY.PARENT_MISMATCH' },
      );
    }
    if (named.parent === undefined && named.name === identity.name) {
      if (!aliasesEqual(named.aliases, [...identity.aliases])) {
        throw new ValidationError(
          `Primary command '${named.name}' aliases must match identity.aliases exactly.`,
          { code: 'TOOL.IDENTITY.ALIAS_DRIFT' },
        );
      }
      primaryCount += 1;
    }
    assertCommandSpec(named);
    normalized.push(named);
  }

  if (primaryCount !== 1) {
    throw new ValidationError(
      `Tool '${identity.name}' must declare exactly one primary command (got ${primaryCount}).`,
      { code: 'TOOL.IDENTITY.PRIMARY_REQUIRED' },
    );
  }

  return normalized;
}

function stripPrimaryDraftMarker(
  spec: PrimaryCommandSpecDraft<unknown, ToolCliContext>,
): Omit<CommandSpec<unknown, ToolCliContext>, 'name' | 'aliases' | 'parent'> {
  const rest = { ...spec };
  delete (rest as Partial<Record<typeof PRIMARY_COMMAND_DRAFT, true>>)[PRIMARY_COMMAND_DRAFT];
  return rest;
}

function stripNestedDraftMarker(
  spec: NestedCommandSpecDraft<unknown, ToolCliContext>,
): Omit<CommandSpec<unknown, ToolCliContext>, 'parent'> {
  const rest = { ...spec };
  delete (rest as Partial<Record<typeof NESTED_COMMAND_DRAFT, true>>)[NESTED_COMMAND_DRAFT];
  return rest;
}

function assertNoDerivedExtensionInputs(input: DefineToolInput): void {
  if (input.extensionPoints?.config !== undefined && 'namespace' in input.extensionPoints.config) {
    throw new ValidationError(
      'config.namespace must not be hand-written when using identity — it is derived from identity.name.',
      { code: 'TOOL.IDENTITY.NAMESPACE_FORBIDDEN' },
    );
  }
  if (
    input.extensionPoints?.sessionReplay !== undefined &&
    'tool' in input.extensionPoints.sessionReplay
  ) {
    throw new ValidationError(
      'sessionReplay.tool must not be hand-written when using identity — it is derived from layoutKey.',
      { code: 'TOOL.IDENTITY.SESSION_TOOL_FORBIDDEN' },
    );
  }
  if (input.pluginLayout !== undefined && 'domain' in input.pluginLayout) {
    throw new ValidationError(
      'pluginLayout.domain must not be hand-written when using identity — it is derived from layoutKey.',
      { code: 'TOOL.IDENTITY.LAYOUT_DOMAIN_FORBIDDEN' },
    );
  }
}

/**
 * Build a host-ready {@link Tool} from the reduced author input.
 */
export function defineTool(input: DefineToolInput): Tool {
  if (input.identity === undefined) {
    throw new ValidationError('Tool identity is required.', { code: 'TOOL.IDENTITY.REQUIRED' });
  }

  const identity = validateToolIdentity(input.identity);
  assertNoDerivedExtensionInputs(input);

  const commandSpecs = normalizeCommandSpecs(input.commandSpecs, identity);
  const commands = deriveCommandsFromSpecs(commandSpecs);

  const extensionPoints: ToolExtensionPoints | undefined =
    input.extensionPoints === undefined
      ? undefined
      : ({
          ...input.extensionPoints,
          ...(input.extensionPoints.config === undefined
            ? {}
            : {
                config: {
                  ...input.extensionPoints.config,
                  namespace: identity.name,
                },
              }),
          ...(input.extensionPoints.sessionReplay === undefined
            ? {}
            : {
                sessionReplay: {
                  ...input.extensionPoints.sessionReplay,
                  tool: identity.layoutKey,
                },
              }),
        } as ToolExtensionPoints);

  const pluginLayout: PluginLayout | undefined =
    input.pluginLayout === undefined
      ? undefined
      : {
          ...input.pluginLayout,
          domain: identity.layoutKey,
        };

  return {
    identity: input.identity,
    metadata: {
      ...input.metadata,
      name: identity.name,
    },
    commands,
    commandSpecs,
    ...(pluginLayout === undefined ? {} : { pluginLayout }),
    ...(input.contractVersion === undefined ? {} : { contractVersion: input.contractVersion }),
    ...(extensionPoints === undefined ? {} : { extensionPoints }),
  };
}
