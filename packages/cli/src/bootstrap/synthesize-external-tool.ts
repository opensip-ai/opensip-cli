/**
 * synthesize-external-tool — build a manifest-derived synthetic {@link Tool} for
 * EXTERNAL provenance, so the HOST can register + mount an external tool's
 * commands WITHOUT importing its untrusted runtime (ADR-0054 M4-G capstone).
 */

import {
  assertCommandSpec,
  defineTool,
  PluginIncompatibleError,
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

/**
 * @throws {PluginIncompatibleError} When an external manifest declares an in-process-only output mode.
 */
function manifestCommandToSpec(cmd: ToolCommandManifest): CommandSpec<unknown, ToolCliContext> {
  if (cmd.output === 'live-view') {
    throw new PluginIncompatibleError(
      `external tool command '${cmd.name}' declares output 'live-view', which is bundled/in-process only; ` +
        "external commands must use 'command-result', 'signal-envelope', or 'raw-stream'.",
      {
        code: 'PLUGIN_INCOMPATIBLE',
        diagnostic: "external command output 'live-view' is not supported",
      },
    );
  }
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
    ...(cmd.producesVerdict === undefined ? {} : { producesVerdict: cmd.producesVerdict }),
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
