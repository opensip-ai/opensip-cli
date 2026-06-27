/**
 * Fixture EXTERNAL tool for the ADR-0054 out-of-process dispatch integration
 * test. Its handler runs IN THE FORKED WORKER (imported by the worker entry's
 * `importToolRuntime`), never in the host. The handler branches on `opts.mode`
 * so one fixture proves both the happy path and the containment paths:
 *
 *   ok        — emit a signal envelope + set exit 0 (happy path; result crosses
 *               the boundary and the host replays it).
 *   exit      — call process.exit(1) inside the handler (containment: the host
 *               must NOT exit; the supervisor turns the premature child exit into
 *               a structured parent-side failure).
 *   throw     — throw inside the handler (containment: structured error message
 *               crosses IPC; host survives).
 *   hang      — spin forever (containment: the supervisor timeout SIGKILLs the
 *               child and surfaces a structured timeout failure; host survives).
 *   live-seam — call a live-view seam (registerLiveView) — host-only; the worker
 *               shim fails loud with an `unsupported-seam` structured error.
 *   rpc       — call the M4-C host-RPC seams (toolState.put/get + saveBaseline +
 *               deliverSignals) IN THE WORKER. Each upcalls the host, which
 *               performs the privileged effect (datastore / egress) and replies.
 *               The handler echoes the round-tripped values into its envelope so
 *               the test can assert the effects happened host-side.
 *   rpc-fail  — call a host-RPC seam the host rejects (toolState.get with a key
 *               the host faults on) — the structured error crosses back and the
 *               handler sees a normal thrown error (proves fault-not-crash).
 *
 * The id matches the manifest (`opensipTools.id` / `stableId`) so the
 * manifest-runtime coherence + provenance match resolve.
 *
 * ADR-0054 M4-E config two-pass: the tool also declares a `config` extension
 * point whose `schema` is a structural Zod-ish `safeParse` stand-in (the worker
 * deep pass duck-types `safeParse`, it does NOT import zod). The schema requires
 * `config.deep === 'ok'`; any other value makes the worker DEEP pass reject with
 * a `config-invalid` failure — surfaced host-side as the same typed config error
 * the coarse pass uses. A fixture (not real zod) keeps the test self-contained
 * while exercising the worker's `isSafeParseable` + `runDeepConfigPass` path.
 */

/**
 * A structural `safeParse`-able schema for the M4-E worker deep config pass. The
 * worker checks for `safeParse` structurally (no zod import), so this fixture
 * shape is all the deep pass needs to accept/reject a config block.
 */
const deepConfigSchema = {
  safeParse(value) {
    if (value !== null && typeof value === 'object' && value.deep === 'ok') {
      return { success: true };
    }
    return {
      success: false,
      error: { issues: [{ path: ['deep'], message: "expected 'ok'" }] },
    };
  },
};

/**
 * ADR-0054 M4-F: module-level sentinels the lifecycle hooks set, so the
 * `init-check` mode can prove `initialize` ran in the SAME (worker) process
 * before the handler. `initPid` records the pid `initialize` ran in.
 */
const initSentinel = { initialized: false, initPid: undefined };

export const tool = {
  identity: { name: 'external-dispatch-tool', aliases: ['ext-run'] },
  metadata: {
    id: 'f1e2d3c4-b5a6-4789-90ab-cdef01234567',
    name: 'external-dispatch-tool',
    version: '0.0.0',
    description: 'fixture external tool for ADR-0054 dispatch',
  },
  extensionPoints: {
    // ADR-0054 M4-E deep config pass: the tool's REAL (here, fixture) Zod-ish
    // schema, run IN THE WORKER after load against the coarse-validated block.
    config: { namespace: 'extdispatch', schema: deepConfigSchema },

    // ADR-0054 M4-F initialize: runs once worker-side before the handler (the host
    // never runs an external owning tool's initialize). Sets a sentinel the
    // `init-check` mode echoes so a test can prove it ran in the worker process.
    initialize: async () => {
      initSentinel.initialized = true;
      initSentinel.initPid = process.pid;
    },

    // ADR-0054 M4-F lifecycle/capability hooks. The host must NOT execute these
    // for an external tool — they run worker-side (contributeScope / capability
    // / initialize during the worker bootstrap; collectReportData / sessionReplay
    // in a forked HOOK worker). Each stamps `process.pid` so a test can prove the
    // hook ran in a DIFFERENT process than the host (the isolation boundary).

    // contributeScope: installs a tool subscope worker-side (host skips it).
    contributeScope: () => ({ extDispatchScope: { pid: process.pid } }),

    // collectReportData: returns a keyed catalog the host merges into the report.
    // Stamps the worker pid + the config it saw so the test can assert it ran in
    // the worker (pid !== host pid) and read worker-local config.
    collectReportData: () => ({
      extDispatchReport: {
        ran: true,
        pid: process.pid,
        marker: 'report-from-worker',
      },
    }),

    // sessionReplay: rebuilds a ToolSessionReplay from a stored row, worker-side.
    sessionReplay: {
      tool: 'external-dispatch-tool',
      replaySession: (stored) => ({
        fidelity: 'projection',
        envelope: {
          schemaVersion: 2,
          tool: 'external-dispatch-tool',
          runId: stored?.id ?? 'replayed',
          createdAt: new Date().toISOString(),
          verdict: {
            score: stored?.score ?? 0,
            passed: stored?.passed ?? false,
            summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
          },
          units: [],
          signals: [{ marker: 'replayed-in-worker', pid: process.pid }],
        },
      }),
    },

    // fingerprintStrategy: a non-default strategy. It is applied TOOL-SIDE at
    // buildSignalEnvelope (which runs in the worker for an external tool), NEVER
    // host-side; the host baseline plane only reads the stamped fingerprint.
    fingerprintStrategy: (signal) =>
      `extdispatch::${signal.ruleId ?? 'rule'}::${signal.filePath ?? 'file'}`,

    // capabilityRegistrars: the REAL registrar for the manifest-declared domain.
    // The host installs only the deferred placeholder for an external tool; the
    // real registrar installs worker-side.
    capabilityRegistrars: {
      'extdispatch-domain': () => ({ contributions: [], pid: process.pid }),
    },
  },
  commands: [
    {
      name: 'external-dispatch-tool',
      aliases: ['ext-run'],
      description: 'fixture external command exercising the ADR-0054 dispatch boundary',
    },
  ],
  commandSpecs: [
    {
      name: 'external-dispatch-tool',
      aliases: ['ext-run'],
      description: 'fixture external command exercising the ADR-0054 dispatch boundary',
      commonFlags: [],
      scope: 'project',
      output: 'signal-envelope',
      handler: async (opts, cli) => {
        const mode = opts.mode ?? 'ok';
        if (mode === 'exit') {
          process.exit(1);
        }
        if (mode === 'throw') {
          throw new Error('external handler boom');
        }
        if (mode === 'hang') {
          // Busy-spin so the supervisor's wall-clock timeout must SIGKILL us.
          // eslint-disable-next-line no-constant-condition
          for (;;) {
            /* never returns */
          }
        }
        if (mode === 'live-seam') {
          // Calls a host-only live-view seam — the worker shim throws
          // UnsupportedSeamError; surfaces as a structured `unsupported-seam`
          // failure (Ink/TTY rendering cannot leave the host).
          cli.registerLiveView('k', () => undefined);
        }
        let rpcEcho = null;
        if (mode === 'rpc') {
          // M4-C host-RPC seams, run IN THE WORKER → upcall the host:
          //  - toolState.put then get (datastore round-trip, host-side);
          //  - saveBaseline (BaselineRepo write, host-side);
          //  - deliverSignals (egress, host-side; returns SignalDeliveryResult).
          await cli.toolState.put('external-dispatch-tool', 'k', {
            v: opts.echo ?? null,
          });
          const got = await cli.toolState.get('external-dispatch-tool', 'k');
          await cli.saveBaseline('external-dispatch-tool', {
            tool: 'external-dispatch-tool',
            signals: [],
          });
          const delivery = await cli.deliverSignals(
            { tool: 'external-dispatch-tool', signals: [] },
            { cwd: process.cwd() },
          );
          const list = await cli.toolState.list('external-dispatch-tool');
          rpcEcho = { got, delivery, list };
        }
        if (mode === 'rpc-fail') {
          // The host faults on this key; the structured error crosses back and is
          // caught here as a normal thrown error (fault-not-crash).
          await cli.toolState.get('external-dispatch-tool', 'boom');
        }
        if (mode === 'report-failure') {
          await cli.reportFailure({
            message: 'fixture command failed',
            exitCode: 3,
            code: 'FIXTURE.FAIL',
            jsonRequested: opts.json === true,
          });
          return;
        }
        if (mode === 'report-failure-large') {
          await cli.reportFailure({
            message: 'x'.repeat(1024 * 1024 + 1),
            exitCode: 3,
            code: 'FIXTURE.FAIL',
          });
          return;
        }
        if (mode === 'fp') {
          // ADR-0054 M4-F: apply the tool's OWN fingerprintStrategy to the signal
          // (exactly what buildSignalEnvelope does at construction time) — this
          // runs HERE, in the worker, never host-side. The host replays the
          // already-fingerprinted envelope and only reads signal.fingerprint.
          const sig = { ruleId: 'r1', filePath: 'f1', marker: 'fp-ran' };
          sig.fingerprint = tool.extensionPoints.fingerprintStrategy(sig);
          cli.emitEnvelope({
            schemaVersion: 2,
            tool: 'external-dispatch-tool',
            runId: cli.scope.runId,
            createdAt: new Date().toISOString(),
            verdict: {
              score: 100,
              passed: true,
              summary: {
                total: 1,
                passed: 1,
                failed: 0,
                errors: 0,
                warnings: 0,
              },
            },
            units: [],
            signals: [sig],
          });
          cli.setExitCode(0);
          return;
        }
        if (mode === 'init-check') {
          // Echo the initialize sentinel so a test can prove initialize ran in the
          // worker (same process) BEFORE this handler.
          cli.emitEnvelope({
            schemaVersion: 2,
            tool: 'external-dispatch-tool',
            runId: cli.scope.runId,
            createdAt: new Date().toISOString(),
            verdict: {
              score: 100,
              passed: true,
              summary: {
                total: 1,
                passed: 1,
                failed: 0,
                errors: 0,
                warnings: 0,
              },
            },
            units: [],
            signals: [
              {
                initialized: initSentinel.initialized,
                initPid: initSentinel.initPid ?? null,
              },
            ],
          });
          cli.setExitCode(0);
          return;
        }
        // Happy path: build a minimal signal envelope and set a clean exit.
        cli.emitEnvelope({
          schemaVersion: 2,
          tool: 'external-dispatch-tool',
          runId: cli.scope.runId,
          createdAt: new Date().toISOString(),
          verdict: {
            score: 100,
            passed: true,
            summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 },
          },
          units: [],
          signals: [{ marker: 'ext-ran', echoedOpt: opts.echo ?? null, rpcEcho }],
        });
        cli.setExitCode(0);
      },
    },
  ],
  apiVersion: 1,
};
