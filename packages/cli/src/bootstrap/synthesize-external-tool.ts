/**
 * synthesize-external-tool — build a manifest-derived synthetic {@link Tool} for
 * EXTERNAL provenance, so the HOST can register + mount an external tool's
 * commands WITHOUT importing its untrusted runtime (ADR-0054 M4-G capstone).
 */

import {
  assertCommandSpec,
  defineTool,
  SystemError,
  type CommandSpec,
  type ManifestOptionDescriptor,
  type OptionSpec,
  type ToolCliContext,
  type ToolCommandManifest,
  type ToolPluginManifest,
} from '@opensip-cli/core';

function externalDispatchStub(
  commandName: string,
): CommandSpec<unknown, ToolCliContext>['handler'] {
  return () => {
    throw new SystemError(
      `external tool command '${commandName}' handler was invoked in the host process; ` +
        'external commands dispatch to a worker (ADR-0054). This indicates the ' +
        'maybeDispatchExternal hook was bypassed — refusing to run untrusted code in-host.',
      { code: 'SYSTEM.DISPATCH.EXTERNAL_HANDLER_UNREACHABLE' },
    );
  };
}

function manifestOptionToSpec(option: ManifestOptionDescriptor): OptionSpec {
  return { ...option };
}

function manifestCommandToSpec(cmd: ToolCommandManifest): CommandSpec<unknown, ToolCliContext> {
  const spec: CommandSpec<unknown, ToolCliContext> = {
    name: cmd.name,
    description: cmd.description,
    ...(cmd.aliases === undefined ? {} : { aliases: cmd.aliases }),
    ...(cmd.visibility === undefined ? {} : { visibility: cmd.visibility }),
    ...(cmd.parent === undefined ? {} : { parent: cmd.parent }),
    commonFlags: cmd.commonFlags ?? [],
    ...(cmd.options === undefined ? {} : { options: cmd.options.map(manifestOptionToSpec) }),
    ...(cmd.args === undefined ? {} : { args: cmd.args }),
    scope: cmd.scope ?? 'project',
    output: cmd.output ?? 'command-result',
    ...(cmd.rawStreamReason === undefined ? {} : { rawStreamReason: cmd.rawStreamReason }),
    handler: externalDispatchStub(cmd.name),
  };
  assertCommandSpec(spec);
  return spec;
}

export function synthesizeExternalTool(
  manifest: ToolPluginManifest,
): ReturnType<typeof defineTool> {
  if (manifest.identity === undefined) {
    throw new SystemError(`external tool manifest '${manifest.id}' is missing required identity`, {
      code: 'SYSTEM.EXTERNAL_TOOL.IDENTITY_MISSING',
    });
  }

  return defineTool({
    identity: manifest.identity,
    metadata: {
      id: manifest.stableId ?? manifest.id,
      version: manifest.version,
      description: `${manifest.id} (external tool)`,
    },
    commandSpecs: manifest.commands.map(manifestCommandToSpec),
    ...(manifest.pluginLayout === undefined
      ? {}
      : { pluginLayout: { userSubdirs: manifest.pluginLayout.userSubdirs } }),
    ...(manifest.config === undefined
      ? {}
      : {
          extensionPoints: {
            config: {
              schema: manifest.config.schema,
            },
          },
        }),
  });
}
