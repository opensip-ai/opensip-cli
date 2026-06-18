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
 */
const mode = process.argv[2];
const send = (msg) => process.send?.(msg);

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
  case 'map-result': {
    send({ kind: 'progress', event: 1 });
    send({ kind: 'result', value: { tag: 'm', map: new Map([['a', 1]]) } });
    break;
  }
  case 'env-echo': {
    // Echo only the OPENSIP_* env back to the parent so the fork-path correlation
    // test can assert OPENSIP_RUN_ID / OPENSIP_WORKER_KIND were injected — without
    // leaking the rest of the parent env into the assertion.
    const opensipEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k.startsWith('OPENSIP_') && v !== undefined) opensipEnv[k] = v;
    }
    send({ kind: 'result', value: opensipEnv });
    break;
  }
  default: {
    send({ kind: 'error', message: `unknown fixture mode: ${String(mode)}` });
  }
}
