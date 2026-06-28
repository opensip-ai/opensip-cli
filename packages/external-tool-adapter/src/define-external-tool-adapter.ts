/**
 * @fileoverview `defineExternalToolAdapter(spec) → Tool` (ADR-0090).
 *
 * A thin authoring factory over `defineTool` — an adapter is an ORDINARY `Tool`
 * (no new plugin kind). It owns: the primary `scan` command (and any additional
 * scanner verbs), the auto-added nested `doctor`/`version` commands, the
 * `message-hash` fingerprint default (stamped WORKER-SIDE in the run loop, never
 * read off the synthetic Tool — `synthesizeExternalTool` drops
 * `fingerprintStrategy`), and the optional namespaced config block.
 *
 * The scan handler runs the run loop and RETURNS a `ToolRunCompletion`
 * (`{ envelope, session }`) — emission/egress happen INSIDE the loop via
 * `cli.*` seams (output mode `raw-stream`/`'runtime-render-dispatch'`, like sim:
 * a runtime-conditional render + egress + session flow no static mode captures).
 */

import {
  defineNestedCommand,
  definePrimaryCommand,
  defineTool,
  ValidationError,
} from '@opensip-cli/core';

import { buildDoctorCommand } from './doctor-command.js';
import { resolveFingerprintStrategy } from './fingerprint.js';
import { runScanLoop } from './run-loop.js';
import { buildVersionCommand } from './version-command.js';

import type { ExternalCommandSpec, ExternalToolAdapterSpec } from './types.js';
import type {
  Tool,
  ToolCliContext,
  ToolCommandSpecInput,
  ToolRunCompletion,
} from '@opensip-cli/core';

const SCAN_COMMON_FLAGS = [
  'json',
  'cwd',
  'quiet',
  'verbose',
  'debug',
  'reportTo',
  'apiKey',
  'open',
] as const;

/** Run one scanner command and shape its result as a `ToolRunCompletion`. */
async function dispatchScan(
  cli: ToolCliContext,
  spec: ExternalToolAdapterSpec,
  command: ExternalCommandSpec,
  rawOpts: unknown,
): Promise<ToolRunCompletion> {
  const completion = await runScanLoop({
    cli,
    tool: spec.identity.name,
    adapterPackage: spec.metadata.adapterPackage,
    command,
    binary: spec.binary,
    fingerprintStrategy: resolveFingerprintStrategy(spec.fingerprintStrategy),
    opts: rawOpts as Record<string, unknown>,
  });
  return { envelope: completion.envelope, session: completion.session };
}

/** Validate the spec at definition time so misconfiguration fails loudly, not at runtime. */
function assertSpec(spec: ExternalToolAdapterSpec): void {
  if (spec.commands.length === 0) {
    throw new ValidationError(
      `External adapter '${spec.identity.name}' must declare at least one command.`,
      {
        code: 'ADAPTER.SPEC.NO_COMMANDS',
      },
    );
  }
  for (const command of spec.commands) {
    if (command.output.kind !== 'sarif' && command.parse === undefined) {
      throw new ValidationError(
        `External adapter '${spec.identity.name}' command '${command.name}' (${command.output.kind}) must declare a 'parse' (only SARIF commands may omit it — the shared ingestSarif handles those).`,
        { code: 'ADAPTER.SPEC.MISSING_PARSE' },
      );
    }
  }
}

/**
 * Build an external-scanner adapter `Tool` from its declarative {@link
 * ExternalToolAdapterSpec}. The first command is the primary verb
 * (`opensip <tool>`); any additional scanner commands mount as nested verbs;
 * `doctor` and `version` are always added.
 */
export function defineExternalToolAdapter(spec: ExternalToolAdapterSpec): Tool {
  assertSpec(spec);
  const [primary, ...rest] = spec.commands;

  const scanPrimary = definePrimaryCommand<unknown, ToolCliContext>({
    description: primary.description ?? spec.metadata.description,
    commonFlags: [...SCAN_COMMON_FLAGS],
    scope: 'project',
    output: 'raw-stream',
    rawStreamReason: 'runtime-render-dispatch',
    handler: (rawOpts, cli) => dispatchScan(cli, spec, primary, rawOpts),
  });

  const nestedScans: ToolCommandSpecInput<unknown, ToolCliContext>[] = rest.map((command) =>
    defineNestedCommand<unknown, ToolCliContext>({
      name: command.name,
      description: command.description ?? `Run the ${spec.identity.name} ${command.name} scan`,
      commonFlags: [...SCAN_COMMON_FLAGS],
      scope: 'project',
      output: 'raw-stream',
      rawStreamReason: 'runtime-render-dispatch',
      handler: (rawOpts, cli) => dispatchScan(cli, spec, command, rawOpts),
    }),
  );

  return defineTool({
    identity: spec.identity,
    metadata: {
      id: spec.metadata.id,
      version: spec.metadata.version ?? '0.0.0',
      description: spec.metadata.description,
    },
    commandSpecs: [
      scanPrimary,
      ...nestedScans,
      buildDoctorCommand({ tool: spec.identity.name, network: spec.network, binary: spec.binary }),
      buildVersionCommand({ tool: spec.identity.name, binary: spec.binary }),
    ],
    ...(spec.contractVersion === undefined ? {} : { contractVersion: spec.contractVersion }),
    extensionPoints: {
      fingerprintStrategy: resolveFingerprintStrategy(spec.fingerprintStrategy),
      ...(spec.config === undefined ? {} : { config: spec.config }),
    },
  });
}
