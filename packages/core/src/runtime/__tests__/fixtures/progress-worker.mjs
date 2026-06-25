/**
 * Fork fixture for subprocess-transport.test.ts. Forked as
 * `node progress-worker.mjs <mode>` with `serialization: 'advanced'`; speaks the
 * WorkerMessage IPC protocol (progress | result | error) back to the parent.
 *
 * Modes:
 *   emit-and-result — three `progress` events then a `result` (the happy path).
 *   error-message   — a `{ kind: 'error' }` message (the worker reported a failure).
 *   throw           — throw uncaught so the child exits non-zero with no result.
 *   exit-clean      — exit 0 without ever sending a result (premature exit).
 *   map-result      — a `result` whose value carries a Map (advanced-serialization proof).
 *   env-echo        — a `result` carrying the child's OPENSIP_* env (correlation proof).
 *   env-echo-full   — like env-echo, plus whether PATH/HOME survived the env merge
 *                     (M2: correlation env must NOT clobber the inherited base env).
 *   traceparent-echo — a `result` carrying the child's TRACEPARENT env (span-nesting proof).
 *   correlation-check — the missing-correlation DEGRADATION (M2): if no
 *                     OPENSIP_RUN_ID is present the child "warns" (proceeds on a
 *                     fresh runId) and reports it through the result so the parent
 *                     test can assert the warn-and-proceed path is observable, not
 *                     silent. If present, it inherits that runId.
 */
const mode = process.argv[2];
const send = (msg) => process.send?.(msg);

/** Collect the child's OPENSIP_* env (correlation proof) — never the rest of env. */
function collectOpensipEnv() {
  const opensipEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('OPENSIP_') && v !== undefined) opensipEnv[k] = v;
  }
  return opensipEnv;
}

switch (mode) {
  case 'emit-and-result': {
    send({ kind: 'progress', event: 1 });
    send({ kind: 'progress', event: 2 });
    send({ kind: 'progress', event: 3 });
    send({ kind: 'result', value: 'done' });
    break;
  }
  case 'error-message': {
    send({ kind: 'error', message: 'worker blew up', stack: 'worker blew up\n  at fixture' });
    break;
  }
  case 'throw': {
    throw new Error('uncaught in worker');
  }
  case 'exit-clean': {
    process.exit(0);
    break;
  }
  case 'huge-payload': {
    send({ kind: 'result', value: 'x'.repeat(2_000_000) });
    break;
  }
  case 'map-result': {
    send({ kind: 'progress', event: 1 });
    send({ kind: 'result', value: { tag: 'm', map: new Map([['a', 1]]) } });
    break;
  }
  case 'env-echo': {
    // Echo only the OPENSIP_* env back to the parent so the fork-path correlation
    // test can assert OPENSIP_RUN_ID / OPENSIP_WORKER_KIND were injected — without
    // leaking the rest of the parent env into the assertion.
    send({ kind: 'result', value: collectOpensipEnv() });
    break;
  }
  case 'env-echo-full': {
    // M2: prove the correlation env was MERGED over the inherited base env, not a
    // wholesale replacement — PATH/HOME (set by the parent) must survive. Report
    // presence booleans only (never the values).
    send({
      kind: 'result',
      value: {
        opensip: collectOpensipEnv(),
        hasPath: process.env.PATH !== undefined,
        hasHome: process.env.HOME !== undefined,
      },
    });
    break;
  }
  case 'traceparent-echo': {
    send({ kind: 'result', value: process.env.TRACEPARENT });
    break;
  }
  case 'correlation-check': {
    // M2 degradation: a child with NO correlation must NOT crash silently — it
    // warns and proceeds on a fresh runId. We model the worker's
    // `cli.subprocess.correlation_missing` path: when OPENSIP_RUN_ID is absent we
    // mint a fresh id and report `warned: true`; when present we inherit it.
    const inherited = process.env.OPENSIP_RUN_ID;
    const hadRunId = inherited !== undefined && inherited.length > 0;
    const runId = hadRunId ? inherited : `RUN_fresh_${String(process.pid)}`;
    if (!hadRunId) {
      // Observable warn (stderr is inherited by the parent): proves the gap is
      // surfaced, not swallowed. The structured shape mirrors the real worker's.
      process.stderr.write(
        `${JSON.stringify({ evt: 'cli.subprocess.correlation_missing', workerKind: 'live-engine', reason: 'no correlation env' })}\n`,
      );
    }
    send({ kind: 'result', value: { hadRunId, mintedFresh: !hadRunId, runId } });
    break;
  }
  default: {
    send({ kind: 'error', message: `unknown fixture mode: ${String(mode)}` });
  }
}
