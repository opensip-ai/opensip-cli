/**
 * @fileoverview The standardized `doctor` command (ADR-0090 §4.9, Phase-0
 * decision 3).
 *
 * Every adapter gets the SAME auto-generated `doctor` (the author writes none):
 * it PROBES the wrapped binary (resolve → version → minVersion → posture →
 * credential-env presence) and reports a plain {@link AdapterDoctorReport} —
 * NOT a `CommandResult` variant (the union is closed in `contracts`).
 *
 * Output mode is `raw-stream`/`'diagnostic-gate'` (not `command-result`): the
 * handler must produce a STRUCTURED `cli.emitJson(report)` for `--json` AND a
 * human `cli.render({ type:'text-lines' })`, then set exit 2 when not-ready. The
 * `command-result` dispatch arm would JSON-stringify a single returned result
 * (it cannot do both shapes) and rejects a void return — so `raw-stream`, the
 * host's sanctioned runtime-conditional output escape (same as `fit export`), is
 * the correct mode. The worker replays the explicit `emitJson`/`render`/
 * `setExitCode` calls. (See the report's "deviation" note.)
 *
 * The probe runs WORKER-SIDE for an installed adapter; readiness drives exit 0
 * (ready) / 2 (not-ready) so CI can gate on `opensip <tool> doctor`.
 */

import { EXIT_CODES } from '@opensip-cli/contracts';
import { defineNestedCommand } from '@opensip-cli/core';

import { defaultBinaryEnvVar, resolveBinary } from './binary-resolver.js';
import { asObject, getString } from './ingest-json.js';
import { defaultBinaryDeps, probeBinaryVersion } from './process-exec.js';

import type { BinaryResolveDeps } from './binary-resolver.js';
import type { ProbeVersionInput } from './process-exec.js';
import type { BinaryResolutionLayer, BinarySpec, NetworkPosture } from './types.js';
import type { ToolCliContext, ToolCommandSpecInput } from '@opensip-cli/core';

const VERSION_PROBE_TIMEOUT_MS = 15_000;

/** Whether the resolved version satisfies the declared minimum. */
export type VersionStatus = 'ok' | 'too-old' | 'unknown' | 'not-applicable';

/** The structured readiness report `doctor` emits (NOT a `CommandResult` variant). */
export interface AdapterDoctorReport {
  readonly tool: string;
  readonly network: NetworkPosture;
  readonly binary: {
    readonly found: boolean;
    readonly command: string;
    readonly path?: string;
    readonly layer?: BinaryResolutionLayer;
  };
  readonly version: {
    readonly detected?: string;
    readonly minVersion?: string;
    readonly status: VersionStatus;
  };
  /** Presence-only (never the value) when the posture needs a credential (ADR-0092/0071). */
  readonly credentialEnv?: { readonly name: string; readonly present: boolean };
  readonly installHint?: string;
  readonly ready: boolean;
}

/** Deps the probe is parameterized over (real impls default; E2E injects fakes). */
export interface DoctorProbeDeps {
  readonly binaryDeps: BinaryResolveDeps;
  readonly probeVersion: (input: ProbeVersionInput) => string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

const DEFAULT_PROBE_DEPS: DoctorProbeDeps = {
  binaryDeps: defaultBinaryDeps,
  probeVersion: probeBinaryVersion,
  env: process.env,
};

/** Parse a semver-ish string to numeric segments (`'8.18.0'` → `[8,18,0]`). */
function parseVersion(raw: string): readonly number[] | undefined {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw);
  if (match === null) return undefined;
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** Compare a detected version against a minimum. */
export function compareVersion(
  detected: string | undefined,
  min: string | undefined,
): VersionStatus {
  if (min === undefined) return 'not-applicable';
  if (detected === undefined) return 'unknown';
  const a = parseVersion(detected);
  const b = parseVersion(min);
  if (a === undefined || b === undefined) return 'unknown';
  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return 'ok';
    if (left < right) return 'too-old';
  }
  return 'ok';
}

/** The inputs to {@link probeAdapter}: the tool identity, posture, binary spec, and resolved config. */
export interface ProbeAdapterInput {
  readonly tool: string;
  readonly network: NetworkPosture;
  readonly binary: BinarySpec;
  readonly config: Readonly<Record<string, unknown>>;
}

/** Probe a binary and build its {@link AdapterDoctorReport}. Pure given deps. */
export function probeAdapter(input: ProbeAdapterInput, deps: DoctorProbeDeps): AdapterDoctorReport {
  const { tool, binary, network } = input;
  const envVar = binary.envVar ?? defaultBinaryEnvVar(tool);
  const resolution = resolveBinary(
    {
      command: binary.command,
      configuredPath: getString(asObject(input.config.binaries)?.[tool], 'path'),
      envPath: deps.env[envVar],
    },
    deps.binaryDeps,
  );

  const detected = resolution.found
    ? deps.probeVersion({
        path: resolution.path,
        versionArgs: binary.versionArgs,
        parse: binary.versionParse,
        timeoutMs: VERSION_PROBE_TIMEOUT_MS,
      })
    : undefined;
  const versionStatus = compareVersion(detected, binary.minVersion);

  const credentialEnv =
    network === 'auth-required'
      ? { name: `OPENSIP_${tool.replaceAll('-', '_').toUpperCase()}_TOKEN`, present: false }
      : undefined;
  const credential =
    credentialEnv === undefined
      ? undefined
      : { ...credentialEnv, present: (deps.env[credentialEnv.name] ?? '').length > 0 };

  const ready =
    resolution.found &&
    versionStatus !== 'too-old' &&
    (network !== 'auth-required' || (credential?.present ?? false));

  return {
    tool,
    network,
    binary: resolution.found
      ? { found: true, command: binary.command, path: resolution.path, layer: resolution.layer }
      : { found: false, command: binary.command },
    version: {
      ...(detected === undefined ? {} : { detected }),
      ...(binary.minVersion === undefined ? {} : { minVersion: binary.minVersion }),
      status: versionStatus,
    },
    ...(credential === undefined ? {} : { credentialEnv: credential }),
    ...(resolution.found || binary.installHint === undefined
      ? {}
      : { installHint: binary.installHint }),
    ready,
  };
}

/** Render an {@link AdapterDoctorReport} as human display lines. */
export function doctorReportLines(report: AdapterDoctorReport): string[] {
  const binaryLine = report.binary.found
    ? `found (${report.binary.layer ?? ''}) ${report.binary.path ?? ''}`
    : `NOT FOUND (${report.binary.command})`;
  const minNote =
    report.version.minVersion === undefined
      ? ''
      : ` (min ${report.version.minVersion}: ${report.version.status})`;
  const lines = [
    `binary:  ${binaryLine}`,
    `version: ${report.version.detected ?? 'unknown'}${minNote}`,
    `network: ${report.network}`,
  ];
  if (report.credentialEnv !== undefined) {
    lines.push(
      `credential ${report.credentialEnv.name}: ${report.credentialEnv.present ? 'set' : 'MISSING'}`,
    );
  }
  if (!report.binary.found && report.installHint !== undefined) {
    lines.push(`install: ${report.installHint}`);
  }
  lines.push(`ready:   ${report.ready ? 'yes' : 'NO'}`);
  return lines;
}

/** The inputs to {@link buildDoctorCommand}: the tool identity, posture, and binary spec. */
export interface DoctorCommandInput {
  readonly tool: string;
  readonly network: NetworkPosture;
  readonly binary: BinarySpec;
}

/**
 * Build the nested `doctor` command. Probes the binary worker-side, emits the
 * structured report (`--json`) or human lines, and sets exit 2 when not-ready.
 */
export function buildDoctorCommand(
  input: DoctorCommandInput,
  probeDeps?: DoctorProbeDeps,
): ToolCommandSpecInput<unknown, ToolCliContext> {
  const deps = probeDeps ?? DEFAULT_PROBE_DEPS;
  return defineNestedCommand<unknown, ToolCliContext>({
    name: 'doctor',
    description: `Check that the ${input.tool} binary is installed and ready`,
    commonFlags: ['json', 'cwd'],
    scope: 'none',
    output: 'raw-stream',
    rawStreamReason: 'diagnostic-gate',
    handler: async (rawOpts, cli) => {
      const opts = rawOpts as { readonly json?: boolean };
      const config = (cli.scope.toolConfig?.[input.tool] ?? {}) as Readonly<
        Record<string, unknown>
      >;
      const report = probeAdapter(
        { tool: input.tool, network: input.network, binary: input.binary, config },
        deps,
      );
      if (opts.json === true) {
        cli.emitJson(report);
      } else {
        await cli.render({
          type: 'text-lines',
          title: `${input.tool} doctor`,
          lines: doctorReportLines(report),
        });
      }
      if (!report.ready) {
        cli.setExitCode(EXIT_CODES.CONFIGURATION_ERROR);
      }
    },
  });
}
