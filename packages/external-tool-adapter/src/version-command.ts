/**
 * @fileoverview The standardized `version` command (ADR-0090 §4.9).
 *
 * Resolves + probes the wrapped binary and prints its version (and path).
 * Output mode `raw-stream`/`'diagnostic-gate'` for the same reason as `doctor`
 * (a structured `--json` shape AND a human line): the handler owns its output.
 * The probe runs worker-side for an installed adapter.
 */

import { defineNestedCommand } from '@opensip-cli/core';

import { defaultBinaryEnvVar, resolveBinary } from './binary-resolver.js';
import { asObject, getString } from './ingest-json.js';
import { defaultBinaryDeps, probeBinaryVersion } from './process-exec.js';

import type { DoctorProbeDeps } from './doctor-command.js';
import type { BinaryResolutionLayer, BinarySpec } from './types.js';
import type { ToolCliContext, ToolCommandSpecInput } from '@opensip-cli/core';

const VERSION_PROBE_TIMEOUT_MS = 15_000;

/** The structured payload `version --json` emits. */
export interface AdapterVersionReport {
  readonly tool: string;
  readonly found: boolean;
  readonly command: string;
  readonly path?: string;
  readonly layer?: BinaryResolutionLayer;
  readonly version?: string;
}

const DEFAULT_PROBE_DEPS: DoctorProbeDeps = {
  binaryDeps: defaultBinaryDeps,
  probeVersion: probeBinaryVersion,
  env: process.env,
};

export interface VersionProbeInput {
  readonly tool: string;
  readonly binary: BinarySpec;
  readonly config: Readonly<Record<string, unknown>>;
}

/** Resolve + probe the binary into an {@link AdapterVersionReport}. Pure given deps. */
export function probeVersionReport(
  input: VersionProbeInput,
  deps: DoctorProbeDeps,
): AdapterVersionReport {
  const { tool, binary } = input;
  const resolution = resolveBinary(
    {
      command: binary.command,
      configuredPath: getString(asObject(input.config.binaries)?.[tool], 'path'),
      envPath: deps.env[binary.envVar ?? defaultBinaryEnvVar(tool)],
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
  return {
    tool,
    found: resolution.found,
    command: binary.command,
    ...(resolution.found ? { path: resolution.path, layer: resolution.layer } : {}),
    ...(detected === undefined ? {} : { version: detected }),
  };
}

export interface VersionCommandInput {
  readonly tool: string;
  readonly binary: BinarySpec;
}

/** Build the nested `version` command (prints the resolved binary version). */
export function buildVersionCommand(
  input: VersionCommandInput,
  probeDeps?: DoctorProbeDeps,
): ToolCommandSpecInput<unknown, ToolCliContext> {
  const deps = probeDeps ?? DEFAULT_PROBE_DEPS;
  return defineNestedCommand<unknown, ToolCliContext>({
    name: 'version',
    description: `Print the resolved ${input.tool} binary version`,
    commonFlags: ['json', 'cwd'],
    scope: 'none',
    output: 'raw-stream',
    rawStreamReason: 'diagnostic-gate',
    handler: async (rawOpts, cli) => {
      const opts = rawOpts as { readonly json?: boolean };
      const config = (cli.scope.toolConfig?.[input.tool] ?? {}) as Readonly<
        Record<string, unknown>
      >;
      const report = probeVersionReport({ tool: input.tool, binary: input.binary, config }, deps);
      if (opts.json === true) {
        cli.emitJson(report);
      } else {
        await cli.render({
          type: 'text-lines',
          title: `${input.tool} version`,
          lines: [
            report.found
              ? `${input.tool} ${report.version ?? 'unknown'} (${report.path ?? ''})`
              : `${input.tool}: binary not found (${report.command})`,
          ],
        });
      }
    },
  });
}
