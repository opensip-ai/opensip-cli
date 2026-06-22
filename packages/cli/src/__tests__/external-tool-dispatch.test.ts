/**
 * external-tool-dispatch — ADR-0054 out-of-process external tool command
 * dispatch, end-to-end over a REAL forked worker (increments M4-C / M4-D /
 * M4-E).
 *
 * After the M4-E trust-tier flip + config two-pass, the supervisor forks the
 * BUILT CLI binary as the internal `__tool-command-worker` subcommand (NOT the
 * worker entry module directly): the worker re-runs the FULL CLI bootstrap, so it
 * DISCOVERS the dispatched tool from `node_modules` and composes its scope/config
 * worker-local before the handler runs. These tests therefore:
 *
 *   - point `cliScript` at `dist/index.js` (require the cli package to be built);
 *   - present the fixture as a genuinely INSTALLED tool in a throwaway project
 *     (`makeInstalledFixtureProject`) so the worker's discovery + admission +
 *     trust path admits it exactly as a real third-party tool — the supervisor
 *     pins the child's cwd to that project;
 *   - set the installed-tool trust allowlist env (installed tools are
 *     deny-by-default).
 *
 * The fixture EXTERNAL tool's handler runs IN THE WORKER (imported there by the
 * bootstrap's `importToolRuntime`), never in this host process. The suite proves:
 *
 *   - happy path: the handler's emitted envelope + exit code cross the boundary
 *     and the supervisor replays them through the host seams;
 *   - config deep pass (M4-E): a config block that fails the tool's own (worker-
 *     side) schema surfaces as `config-invalid` — a typed config error host-side,
 *     the host survives, no handler effect ran; a block that passes runs normally;
 *   - host-RPC (M4-C): a handler that calls `toolState.put`/`get` +
 *     `saveBaseline` + `deliverSignals` IN THE WORKER upcalls the host, which
 *     performs the privileged effect (datastore / egress) and replies — the
 *     EFFECT is asserted on the host capture, while ISOLATION still holds;
 *   - host-RPC fault: a host-side RPC rejection crosses back as a normal thrown
 *     error in the handler (fault-not-crash);
 *   - isolation: a handler that `process.exit(1)`s, throws, hangs (timeout), or
 *     calls a host-only live-view seam is contained as a STRUCTURED parent-side
 *     failure while THIS host process survives — the worker-by-default flip never
 *     runs untrusted code in-host.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigurationError, ToolError, type ToolProvenance } from '@opensip-cli/core';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';

import { dispatchExternalToolCommand } from '../bootstrap/dispatch-external-tool-command.js';

import { makeDispatchHostCtx, type CapturedHostCtx } from './harness/dispatch-host-ctx.js';
import {
  FIXTURE_TOOL_ID,
  FIXTURE_TRUST_ENV,
  makeInstalledFixtureProject,
  type InstalledFixtureProject,
} from './harness/installed-fixture-project.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// The test source lives at packages/cli/src/__tests__; the built CLI binary lives
// at packages/cli/dist/index.js. The supervisor forks it as `__tool-command-worker`.
const PKG_ROOT = join(HERE, '..', '..');
const CLI_SCRIPT = join(PKG_ROOT, 'dist', 'index.js');

// One installed-fixture project shared across the suite (built once, read-only).
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

interface DispatchOverrides {
  readonly opts?: Record<string, unknown>;
  readonly config?: unknown;
  readonly timeoutMs?: number;
  readonly provenancePatch?: Partial<ToolProvenance>;
  readonly cliScript?: string;
}

function dispatch(cap: CapturedHostCtx, mode: string, over: DispatchOverrides = {}): Promise<void> {
  return dispatchExternalToolCommand({
    provenance: { ...provenance(), ...over.provenancePatch },
    commandName: 'ext-run',
    // `cwd` steers the worker's discovery + project resolution to the fixture
    // project (the supervisor pins the child's cwd to it).
    opts: { mode, cwd: project.projectDir, ...over.opts },
    positionals: [],
    ctx: cap.ctx,
    cliScript: over.cliScript ?? CLI_SCRIPT,
    ...(over.config === undefined ? {} : { config: over.config }),
    ...(over.timeoutMs === undefined ? {} : { timeoutMs: over.timeoutMs }),
  });
}

describe('dispatchExternalToolCommand — ADR-0054 out-of-process boundary', () => {
  beforeAll(() => {
    if (!existsSync(CLI_SCRIPT)) {
      throw new Error(
        `built CLI binary not found at ${CLI_SCRIPT} — run \`pnpm --filter=opensip-cli build\` first`,
      );
    }
    project = makeInstalledFixtureProject();
    // Installed tools are deny-by-default; trust the fixture so the worker admits
    // it (the supervisor forks with the parent env, so this is inherited).
    process.env[FIXTURE_TRUST_ENV] = FIXTURE_TOOL_ID;
  });

  afterEach(() => {
    // Re-affirm the allowlist between cases (defensive against a stray test that
    // clears it). Idempotent.
    process.env[FIXTURE_TRUST_ENV] = FIXTURE_TOOL_ID;
  });

  it('happy path: the handler runs in the worker and its result crosses the boundary', async () => {
    const cap = makeDispatchHostCtx();
    await dispatch(cap, 'ok', { opts: { echo: 'hello' } });

    // The envelope the fixture emitted IN THE WORKER was replayed through the
    // host emitEnvelope seam.
    expect(cap.envelopes).toHaveLength(1);
    const env = cap.envelopes[0] as {
      tool: string;
      signals: { marker: string; echoedOpt: string }[];
    };
    expect(env.tool).toBe('external-dispatch-tool');
    expect(env.signals[0]?.marker).toBe('ext-ran');
    expect(env.signals[0]?.echoedOpt).toBe('hello');
    // The worker's setExitCode(0) was replayed.
    expect(cap.exitCodes).toContain(0);
  });

  it('config deep pass (M4-E): a valid config block lets the run proceed', async () => {
    const cap = makeDispatchHostCtx();
    // The fixture's worker-side schema accepts `{ deep: 'ok' }` → handler runs.
    await dispatch(cap, 'ok', { opts: { echo: 'cfg-ok' }, config: { deep: 'ok' } });
    expect(cap.envelopes).toHaveLength(1);
    expect(cap.exitCodes).toContain(0);
  });

  it('config deep pass (M4-E): a config block the worker schema rejects surfaces as config-invalid (host survives)', async () => {
    const cap = makeDispatchHostCtx();
    // The fixture's worker-side schema rejects `{ deep: 'bad' }`. The worker
    // crosses a structured `config-invalid` error; the supervisor maps it to the
    // SAME typed ConfigurationError the host coarse pass would throw.
    await expect(dispatch(cap, 'ok', { config: { deep: 'bad' } })).rejects.toBeInstanceOf(
      ConfigurationError,
    );
    // The handler never ran (config failure short-circuits before any effect).
    expect(cap.envelopes).toHaveLength(0);
    expect(cap.exitCodes).toHaveLength(0);
  });

  it('config deep pass (M4-E): the config-invalid error names the offending namespace key', async () => {
    const cap = makeDispatchHostCtx();
    await expect(dispatch(cap, 'ok', { config: { deep: 'bad' } })).rejects.toThrow(
      /Invalid configuration.*extdispatch\.deep/,
    );
  });

  it('isolation: a handler process.exit(1) is contained as a structured failure (host survives)', async () => {
    const cap = makeDispatchHostCtx();
    // If isolation FAILED, the child exit would take this process down before the
    // assertion ran. Reaching the rejection proves containment.
    await expect(dispatch(cap, 'exit')).rejects.toBeInstanceOf(ToolError);
    // No result replayed.
    expect(cap.envelopes).toHaveLength(0);
  });

  it('isolation: a handler throw crosses IPC as a structured failure', async () => {
    const cap = makeDispatchHostCtx();
    await expect(dispatch(cap, 'throw')).rejects.toThrow(/external handler boom/);
  });

  it('isolation: a hung handler is SIGKILLed by the supervisor timeout', async () => {
    const cap = makeDispatchHostCtx();
    await expect(dispatch(cap, 'hang', { timeoutMs: 4000 })).rejects.toThrow(/timed out|failed/);
  }, 15_000);

  it('a host-only live-view seam fails loud (unsupported-seam) — never a silent no-op', async () => {
    const cap = makeDispatchHostCtx();
    await expect(dispatch(cap, 'live-seam')).rejects.toThrow(/failed/);
  });

  it('host-RPC (M4-C): worker seam calls upcall the host, which performs the effect host-side', async () => {
    const cap = makeDispatchHostCtx();
    await dispatch(cap, 'rpc', { opts: { echo: 'via-rpc' } });

    // The datastore write happened HOST-SIDE via the toolState.put upcall.
    expect(cap.toolStateStore.get('external-dispatch-tool:k')).toEqual({ v: 'via-rpc' });
    // The baseline was saved HOST-SIDE via the saveBaseline upcall.
    expect(cap.baselines).toHaveLength(1);
    expect(cap.baselines[0]?.tool).toBe('external-dispatch-tool');
    // The envelope was delivered HOST-SIDE via the deliverSignals upcall.
    expect(cap.delivered).toHaveLength(1);

    // The round-tripped reply values reached the WORKER handler and were echoed
    // into its envelope (proves the reply crossed back, not just fired).
    const env = cap.envelopes[0] as {
      signals: {
        rpcEcho: { got: { v: string }; delivery: { cloudAccepted: number }; list: string[] };
      }[];
    };
    const echo = env.signals[0]?.rpcEcho;
    expect(echo?.got).toEqual({ v: 'via-rpc' });
    expect(echo?.delivery).toEqual({ cloudAccepted: 0 });
    expect(echo?.list).toContain('k');
    expect(cap.exitCodes).toContain(0);
  });

  it('host-RPC fault: a host-side RPC rejection crosses back as a structured failure (host survives)', async () => {
    const cap = makeDispatchHostCtx();
    // The handler calls toolState.get('boom'); the host rejects; the worker shim
    // re-throws into the handler, which does not catch → tool-handler-throw.
    await expect(dispatch(cap, 'rpc-fail')).rejects.toThrow(/faulted for key boom|failed/);
    // No envelope replayed (the handler never reached its emit).
    expect(cap.envelopes).toHaveLength(0);
  });

  it('the host still dispatches a happy run AFTER containing a fault (host survived)', async () => {
    // Prove the host process is still fully functional after the isolation cases:
    // contain a fault, then dispatch a clean run in the SAME process and assert it
    // crosses the boundary correctly. A crashed host could not run this.
    const faulted = makeDispatchHostCtx();
    await expect(dispatch(faulted, 'exit')).rejects.toBeInstanceOf(ToolError);

    const ok = makeDispatchHostCtx();
    await dispatch(ok, 'ok', { opts: { echo: 'after-fault' } });
    const env = ok.envelopes[0] as { signals: { echoedOpt: string }[] };
    expect(env.signals[0]?.echoedOpt).toBe('after-fault');
    expect(ok.exitCodes).toContain(0);
  });

  it('rejects a bundled tool with a structured misuse error (bundled runs in-process)', async () => {
    const cap = makeDispatchHostCtx();
    await expect(
      dispatchExternalToolCommand({
        provenance: { ...provenance(), source: 'bundled' },
        commandName: 'ext-run',
        opts: { mode: 'ok' },
        positionals: [],
        ctx: cap.ctx,
        cliScript: CLI_SCRIPT,
      }),
    ).rejects.toThrow(/bundled tools run in-process/);
  });

  it('rejects when an external tool has no resolved package dir to dispatch from', async () => {
    const cap = makeDispatchHostCtx();
    await expect(
      dispatchExternalToolCommand({
        provenance: { ...provenance(), resolvedPath: undefined },
        commandName: 'ext-run',
        opts: { mode: 'ok' },
        positionals: [],
        ctx: cap.ctx,
        cliScript: CLI_SCRIPT,
      }),
    ).rejects.toThrow(/no resolved package path/);
  });
});
