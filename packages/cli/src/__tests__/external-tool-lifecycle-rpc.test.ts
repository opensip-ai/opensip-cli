/**
 * external-tool-lifecycle-rpc — ADR-0054 M4-F: external-provenance lifecycle +
 * capability hooks run WORKER-SIDE (or over the hook worker), never in the host
 * process. End-to-end over a REAL forked worker, reusing the M4-E installed-
 * fixture harness.
 *
 * The ADR's M4-F exit criterion: "an external tool contributing collectReportData
 * + a capability domain WITHOUT a host runtime import." These tests prove it by
 * dispatching the fixture's `collectReportData` / `sessionReplay` hooks over
 * {@link dispatchExternalToolHook} (a forked `__tool-command-worker` in HOOK mode)
 * and asserting the hook result carries the WORKER's `process.pid` — different
 * from THIS host process's pid, which is only possible if the hook ran in a
 * separate worker process (the isolation boundary), not in-host.
 *
 * `fingerprintStrategy` is proven already-satisfied: the fixture's command emits
 * a signal envelope whose signals arrive at the host ALREADY fingerprinted with
 * the tool's non-default strategy — applied tool-side at envelope construction (in
 * the worker), never executed by the host.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type ToolProvenance } from '@opensip-cli/core';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

import { dispatchExternalToolCommand } from '../bootstrap/dispatch-external-tool-command.js';
import { dispatchExternalToolHook } from '../bootstrap/dispatch-external-tool-hook.js';

import { makeDispatchHostCtx } from './harness/dispatch-host-ctx.js';
import {
  FIXTURE_TOOL_ID,
  FIXTURE_TRUST_ENV,
  makeInstalledFixtureProject,
  type InstalledFixtureProject,
} from './harness/installed-fixture-project.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..', '..');
const CLI_SCRIPT = join(PKG_ROOT, 'dist', 'index.js');

let project: InstalledFixtureProject;

function provenance(): ToolProvenance {
  return {
    source: 'installed',
    id: FIXTURE_TOOL_ID,
    stableId: 'f1e2d3c4-b5a6-4789-90ab-cdef01234567',
    version: '0.0.0',
    packageName: '@opensip-cli-fixture/external-dispatch-tool',
    resolvedPath: project.packageDir,
    manifestHash: 'test-hash',
  };
}

describe('ADR-0054 M4-F — external lifecycle/capability hooks run off-host', () => {
  beforeAll(() => {
    if (!existsSync(CLI_SCRIPT)) {
      throw new Error(
        `built CLI binary not found at ${CLI_SCRIPT} — run \`pnpm --filter=opensip-cli build\` first`,
      );
    }
    project = makeInstalledFixtureProject();
    process.env[FIXTURE_TRUST_ENV] = FIXTURE_TOOL_ID;
  });

  afterEach(() => {
    process.env[FIXTURE_TRUST_ENV] = FIXTURE_TOOL_ID;
  });

  it('collectReportData (exit criterion): runs in a worker WITHOUT a host import — its contribution crosses back, stamped with the worker pid', async () => {
    const cap = makeDispatchHostCtx();
    const result = await dispatchExternalToolHook({
      provenance: provenance(),
      hook: 'collectReportData',
      cwd: project.projectDir,
      ctx: cap.ctx,
      cliScript: CLI_SCRIPT,
    });

    // The hook ran and contributed its keyed catalog (the host merges this).
    const report = (result as { extDispatchReport?: { ran: boolean; pid: number; marker: string } })
      .extDispatchReport;
    expect(report?.ran).toBe(true);
    expect(report?.marker).toBe('report-from-worker');
    // The DECISIVE assertion: the hook ran in a SEPARATE process (the worker), not
    // in this host process. A host-side execution would carry THIS pid.
    expect(report?.pid).toBeTypeOf('number');
    expect(report?.pid).not.toBe(process.pid);
  });

  it('sessionReplay: rebuilds the replay in a worker — the envelope is stamped with the worker pid (not the host pid)', async () => {
    const cap = makeDispatchHostCtx();
    const stored = { id: 'sess-1', tool: 'external-dispatch-tool', score: 42, passed: true };
    const result = await dispatchExternalToolHook({
      provenance: provenance(),
      hook: 'sessionReplay',
      hookArg: stored,
      cwd: project.projectDir,
      ctx: cap.ctx,
      cliScript: CLI_SCRIPT,
    });

    const replay = result as {
      fidelity: string;
      envelope: { runId: string; signals: { marker: string; pid: number }[] };
    };
    expect(replay.fidelity).toBe('projection');
    expect(replay.envelope.runId).toBe('sess-1');
    expect(replay.envelope.signals[0]?.marker).toBe('replayed-in-worker');
    // Ran in the worker process, not in-host.
    expect(replay.envelope.signals[0]?.pid).not.toBe(process.pid);
  });

  it('fingerprintStrategy is applied tool-side in the worker, never host-executed — the host sees an already-fingerprinted envelope', async () => {
    // The fixture's `fp` mode emits an envelope with an unstamped signal; its
    // declared fingerprintStrategy stamps it at buildSignalEnvelope time IN THE
    // WORKER. The host replays the envelope through emitEnvelope and never touches
    // the strategy (it only reads signal.fingerprint).
    const cap = makeDispatchHostCtx();
    await dispatchExternalToolCommand({
      provenance: provenance(),
      commandName: 'ext-run',
      opts: { mode: 'fp', cwd: project.projectDir },
      positionals: [],
      ctx: cap.ctx,
      cliScript: CLI_SCRIPT,
    });
    const env = cap.envelopes[0] as { signals: { fingerprint?: string }[] };
    // The signal arrived already fingerprinted with the tool's NON-default
    // strategy (extdispatch::…), proving the strategy ran where the envelope was
    // built — the worker — not in the host baseline plane.
    expect(env.signals[0]?.fingerprint).toMatch(/^extdispatch::/);
  });

  it('initialize runs in the worker before the handler (a sentinel set by initialize is visible to the handler), not in-host', async () => {
    // The fixture's `init-check` mode reads a flag the fixture's `initialize` set;
    // the handler echoes it. If initialize did NOT run worker-side the flag would
    // be absent. (initialize never runs in this host process — the fixture is
    // imported only in the worker.)
    const cap = makeDispatchHostCtx();
    await dispatchExternalToolCommand({
      provenance: provenance(),
      commandName: 'ext-run',
      opts: { mode: 'init-check', cwd: project.projectDir },
      positionals: [],
      ctx: cap.ctx,
      cliScript: CLI_SCRIPT,
    });
    const env = cap.envelopes[0] as { signals: { initialized?: boolean; initPid?: number }[] };
    expect(env.signals[0]?.initialized).toBe(true);
    // initialize ran in the SAME worker process as the handler (a separate process
    // from this host).
    expect(env.signals[0]?.initPid).not.toBe(process.pid);
  });
});
