/**
 * synthesize-external-tool — build a manifest-derived synthetic {@link Tool} for
 * EXTERNAL provenance, so the HOST can register + mount an external tool's
 * commands WITHOUT importing its untrusted runtime (ADR-0054 M4-G capstone).
 *
 * After M4-C…F every host consumer of an external tool's RUNTIME hooks either
 * skips external provenance (config/capabilities/scope/report/replay all gate on
 * `provenanceSourceFor`) or routes the hook to a worker. The ONLY thing the host
 * still needs from an external `Tool` is the command SHELL for
 * `mountAllToolCommands` (`commandSpecs`) — name, description, aliases, parent,
 * commonFlags, options, args, scope, output, visibility. The capstone lifts that
 * shell into the static manifest ({@link ToolCommandManifest}), so the host builds
 * the registry entry from the manifest ALONE.
 *
 * The synthetic tool is a `Tool`-shaped object so EVERY `registry.list()` consumer
 * keeps working unchanged. Its differences from a real runtime are exactly the
 * things the host must never touch for external provenance:
 *
 *   - NO `extensionPoints` — the host runs no external lifecycle/capability hooks
 *     (M4-F). The WORKER, which imports the real runtime, has the real hooks.
 *   - the per-command `handler` is a fail-loud DISPATCH STUB. The host NEVER calls
 *     it: `maybeDispatchExternal` (mount-command-spec.ts) intercepts external
 *     provenance and dispatches to the worker BEFORE the handler runs. The stub is
 *     insurance — if a refactor ever bypassed the hook, the run fails with a clear
 *     message instead of silently mis-running a no-op handler in-host.
 *
 * The WORKER never synthesizes: it re-runs the SAME bootstrap with
 * `OPENSIP_CLI_IN_TOOL_WORKER=1`, so its discovery imports the real runtime (the
 * isolation boundary). See `register-tools-discovery.ts` for the host/worker gate.
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

/**
 * The fail-loud handler every synthetic external command carries. The host never
 * reaches it (the dispatch hook intercepts external provenance first), so a call
 * here means a bypass bug — fail loudly rather than silently no-op in-host.
 *
 * @throws {SystemError} always — a synthetic external handler must never run
 *   in-host (the worker owns the real handler).
 */
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

/** A `ManifestOptionDescriptor` IS an `OptionSpec` minus `parse` — carry it verbatim. */
function manifestOptionToSpec(option: ManifestOptionDescriptor): OptionSpec {
  // The descriptor has every OptionSpec field except `parse` (the non-serializable
  // coercion closure). The host mounts the option WITHOUT a parse reducer; the
  // worker (with the tool's real spec) coerces in its handler.
  return { ...option };
}

/**
 * Build one synthetic {@link CommandSpec} from a manifest command shell. Applies
 * the runtime `CommandSpec` defaults for any omitted shell field
 * (`commonFlags: []`, `scope: 'project'`, `output: 'command-result'`), then
 * runs it through `assertCommandSpec` so a malformed external manifest fails
 * loudly at synthesize time (the same guard `defineCommand` uses).
 */
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
  // Fail loud on a malformed external manifest shell (mirrors defineCommand).
  assertCommandSpec(spec);
  return spec;
}

/**
 * Build a manifest-derived synthetic {@link Tool} for an EXTERNAL admitted tool.
 * The host registers + mounts it WITHOUT importing the tool's runtime. The
 * `metadata` mirrors the runtime shape a real tool registers with (post-ADR-0048:
 * `metadata.id` = stable UUID for modern tools, `metadata.name` = human key), so
 * every registry/provenance/conflict matcher resolves it identically. No
 * `extensionPoints` (the host runs no external hooks); each command's handler is
 * a fail-loud dispatch stub.
 *
 * @param manifest The admitted static manifest (from `loadToolManifest` + the
 *   compatibility gate). Carries the command shells (ADR-0054 M4-G).
 */
export function synthesizeExternalTool(
  manifest: ToolPluginManifest,
): ReturnType<typeof defineTool> {
  return defineTool({
    metadata: {
      id: manifest.stableId ?? manifest.id,
      name: manifest.id,
      version: manifest.version,
      // The manifest has no tool-level description (name/version derive from
      // package.json); a display-only fallback — never asserted by the drift
      // guard (which the host skips for synthetic external tools) or any matcher.
      description: `${manifest.id} (external tool)`,
    },
    commandSpecs: manifest.commands.map(manifestCommandToSpec),
    // ADR-0054 M4-G: carry the serializable plugin layout so the host mounts the
    // domain-bound `<tool> plugin …` extension-pack group + drives `init`
    // scaffolding identically to a bundled tool — without importing the runtime.
    // A pack-supporting external tool declares it in its manifest; omitted ⇒ no
    // `plugin` subgroup (the tool hosts no extension packs).
    ...(manifest.pluginLayout === undefined ? {} : { pluginLayout: manifest.pluginLayout }),
  });
}
