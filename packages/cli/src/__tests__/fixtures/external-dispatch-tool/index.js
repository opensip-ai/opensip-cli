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
 *   bad-seam  — call an unmarshalled host-RPC seam (toolState) — the worker shim
 *               fails loud with an `unsupported-seam` structured error.
 *
 * The id matches the manifest (`opensipTools.id` / `stableId`) so the
 * manifest-runtime coherence + provenance match resolve.
 */
export const tool = {
  metadata: {
    id: 'f1e2d3c4-b5a6-4789-90ab-cdef01234567',
    name: 'external-dispatch-tool',
    version: '0.0.0',
    description: 'fixture external tool for ADR-0054 dispatch',
  },
  commands: [
    {
      name: 'ext-run',
      description: 'fixture external command exercising the ADR-0054 dispatch boundary',
    },
  ],
  commandSpecs: [
    {
      name: 'ext-run',
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
        if (mode === 'bad-seam') {
          // Calls a seam not marshalled in the dispatch slice — the worker shim
          // throws UnsupportedSeamError; surfaces as a structured failure.
          await cli.toolState.get('external-dispatch-tool', 'k');
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
          signals: [{ marker: 'ext-ran', echoedOpt: opts.echo ?? null }],
        });
        cli.setExitCode(0);
      },
    },
  ],
  apiVersion: 1,
};
