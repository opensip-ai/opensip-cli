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

import { defaultAdapterConfig, defaultAdapterConfigManifest } from './adapter-config.js';
import { type AdapterToolMarkers } from './adapter-manifest.js';
import { buildDoctorCommand } from './doctor-command.js';
import { resolveFingerprintStrategy } from './fingerprint.js';
import { runScanLoop } from './run-loop.js';
import { buildVersionCommand } from './version-command.js';

import type { ExternalCommandSpec, ExternalToolAdapterSpec } from './types.js';
import type {
  OptionSpec,
  Tool,
  ToolCliContext,
  ToolCommandSpecInput,
  ToolConfigManifestDescriptor,
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

/**
 * The baseline-ratchet flags every scanner verb inherits (ADR-0036). Wired ONCE
 * here so all adapters get the host gate loop verbatim — `--gate-save` captures
 * the current fingerprint-stamped findings as the project baseline; `--gate-compare`
 * diffs against it and (per the reserved `failOnDegraded` key) hard-fails on
 * net-new findings. Mirrors fit's `--gate-save` / `--gate-compare` descriptions;
 * the run loop reads them as `opts.gateSave` / `opts.gateCompare`.
 */
const SCAN_GATE_OPTIONS: readonly OptionSpec[] = [
  {
    flag: '--gate-save',
    description:
      'Architecture-gate: save current findings as baseline in the project SQLite store (mutually exclusive with --gate-compare)',
    default: false,
  },
  {
    flag: '--gate-compare',
    description:
      'Architecture-gate: compare current findings against the saved baseline; exit 1 on regression',
    default: false,
  },
];

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
  // `undefined` ⇒ a gate config error the loop already recorded via reportFailure
  // (the host replays the exit). No envelope/session to persist.
  if (completion === undefined) return {};
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

  // R6 (ADR-0090 §4.3): an adapter that declares no `config` DEFAULTS to claiming
  // its namespace (`binaries.<tool>.path` operator pin + the reserved verdict-policy
  // keys) so the resolver/gate keys are configurable AND an operator's `<tool>:`
  // block never bricks the project. When the adapter uses the DEFAULT config the
  // substrate can also emit a coarse, serializable manifest descriptor (the host
  // pre-fork pass needs it — it cannot import the runtime Zod). A custom `spec.config`
  // keeps the runtime Zod but emits NO descriptor (its validation defers to the
  // worker deep pass), so `adapterConfigManifest` stays undefined.
  const config = spec.config ?? defaultAdapterConfig();
  const configManifest: ToolConfigManifestDescriptor | undefined =
    spec.config === undefined ? defaultAdapterConfigManifest(spec.identity.name) : undefined;

  const scanPrimary = definePrimaryCommand<unknown, ToolCliContext>({
    description: primary.description ?? spec.metadata.description,
    commonFlags: [...SCAN_COMMON_FLAGS],
    options: [...SCAN_GATE_OPTIONS],
    scope: 'project',
    output: 'raw-stream',
    rawStreamReason: 'runtime-render-dispatch',
    // The scan dispatch emits a SignalEnvelope verdict (worker replay) → eligible as a suite step.
    producesVerdict: true,
    handler: (rawOpts, cli) => dispatchScan(cli, spec, primary, rawOpts),
  });

  const nestedScans: ToolCommandSpecInput<unknown, ToolCliContext>[] = rest.map((command) =>
    defineNestedCommand<unknown, ToolCliContext>({
      name: command.name,
      description: command.description ?? `Run the ${spec.identity.name} ${command.name} scan`,
      commonFlags: [...SCAN_COMMON_FLAGS],
      options: [...SCAN_GATE_OPTIONS],
      scope: 'project',
      output: 'raw-stream',
      rawStreamReason: 'runtime-render-dispatch',
      // The scan dispatch emits a SignalEnvelope verdict (worker replay) → eligible as a suite step.
      producesVerdict: true,
      handler: (rawOpts, cli) => dispatchScan(cli, spec, command, rawOpts),
    }),
  );

  const tool = defineTool({
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
      config,
    },
  });

  // Stamp the adapter-substrate markers the manifest generator + parity gate read
  // back (`adapter-manifest.ts`): the network posture (→ `requires`) and the coarse
  // config descriptor (→ `opensipTools.config`). Kept off the core `Tool` contract
  // — these are adapter concepts, not kernel ones.
  const markers: AdapterToolMarkers = {
    adapterNetwork: spec.network,
    ...(configManifest === undefined ? {} : { adapterConfigManifest: configManifest }),
  };
  return Object.assign(tool, markers);
}
