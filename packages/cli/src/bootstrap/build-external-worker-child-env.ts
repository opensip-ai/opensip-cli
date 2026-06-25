/**
 * build-external-worker-child-env — explicit allow-list for the ADR-0054
 * external-tool dispatch worker fork (spec 01 / DD8).
 *
 * Replaces `{ ...process.env }` on the external fork so admitted tools do not
 * inherit arbitrary parent secrets. Bundled live-run forks (subprocess-transport)
 * are out of scope — they are TCB and still spread the parent env.
 */

import { IN_TOOL_WORKER_ENV } from './tool-provenance.js';

/** Env var listing extra parent vars to forward (comma/whitespace-separated). */
export const TOOL_ENV_PASSTHROUGH_ENV = 'OPENSIP_CLI_TOOL_ENV_PASSTHROUGH';

/** Default pass-through set for external-tool worker children (OQ2). */
export const EXTERNAL_WORKER_CHILD_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NODE_ENV',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OPENSIP_PROFILING',
];

function parsePassthroughKeys(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.length === 0) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Build the child env for an external-tool dispatch worker fork.
 *
 * Forwards only the documented allow-list plus `OPENSIP_CLI_TOOL_ENV_PASSTHROUGH`
 * keys from the parent. Host-set worker markers (`IN_TOOL_WORKER_ENV`,
 * `OPENSIP_RUN_ID`, `TRACEPARENT`) are never read from the parent.
 */
export function buildExternalWorkerChildEnv(
  args: {
    readonly parentEnv?: NodeJS.ProcessEnv;
    readonly runId?: string;
    readonly traceparent?: string;
  } = {},
): NodeJS.ProcessEnv {
  const parentEnv = args.parentEnv ?? process.env;
  const childEnv: NodeJS.ProcessEnv = {};

  for (const key of EXTERNAL_WORKER_CHILD_ENV_ALLOWLIST) {
    const value = parentEnv[key];
    if (value !== undefined) childEnv[key] = value;
  }

  for (const key of parsePassthroughKeys(parentEnv[TOOL_ENV_PASSTHROUGH_ENV])) {
    const value = parentEnv[key];
    if (value !== undefined) childEnv[key] = value;
  }

  childEnv[IN_TOOL_WORKER_ENV] = '1';
  if (args.runId !== undefined && args.runId.length > 0) {
    childEnv.OPENSIP_RUN_ID = args.runId;
  }
  if (args.traceparent !== undefined && args.traceparent.length > 0) {
    childEnv.TRACEPARENT = args.traceparent;
  }

  return childEnv;
}
