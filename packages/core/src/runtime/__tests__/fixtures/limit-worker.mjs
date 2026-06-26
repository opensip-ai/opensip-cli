/**
 * Limit-path fixture for fork-and-settle / subprocess-transport hardening tests.
 */
import { fork } from 'node:child_process';

const mode = process.argv[2];
const send = (msg) => process.send?.(msg);

switch (mode) {
  case 'env-report': {
    send({
      kind: 'env',
      custom: process.env.OPENSIP_TEST_CUSTOM,
      runId: process.env.OPENSIP_RUN_ID,
    });
    break;
  }
  case 'echo': {
    process.on('message', (msg) => {
      send({ kind: 'echo', msg });
    });
    send({ kind: 'ready' });
    setInterval(() => {}, 60_000).unref?.();
    break;
  }
  case 'message-then-idle': {
    send({ kind: 'ready' });
    setInterval(() => {}, 60_000).unref?.();
    break;
  }
  case 'huge-payload': {
    send({ kind: 'result', value: 'x'.repeat(2_000_000) });
    break;
  }
  case 'heartbeat-sleep': {
    // Never sends heartbeat; supervisor should kill with heartbeat_missed.
    setInterval(() => {}, 60_000).unref?.();
    break;
  }
  case 'heartbeat-ok': {
    const beat = setInterval(() => send({ kind: 'heartbeat' }), 200);
    beat.unref?.();
    setTimeout(() => {
      clearInterval(beat);
      send({ kind: 'result', value: 'ok' });
    }, 1500);
    break;
  }
  case 'fork-grandchild': {
    const grand = fork(new URL(import.meta.url), ['grandchild-sleep'], {
      detached: true,
      stdio: 'ignore',
    });
    send({ kind: 'grandchild', pid: grand.pid });
    grand.unref?.();
    setInterval(() => {}, 60_000).unref?.();
    break;
  }
  case 'grandchild-sleep': {
    setInterval(() => {}, 60_000).unref?.();
    break;
  }
  case 'stderr-flood': {
    for (let i = 0; i < 5000; i += 1) {
      process.stderr.write(`line-${String(i)}\n`);
    }
    send({ kind: 'error', message: 'failed after stderr flood' });
    break;
  }
  case 'timeout-sleep': {
    setInterval(() => {}, 60_000).unref?.();
    break;
  }
  case 'rss-hold': {
    setInterval(() => {}, 60_000);
    break;
  }
  default: {
    send({ kind: 'error', message: `unknown limit-worker mode: ${String(mode)}` });
  }
}
