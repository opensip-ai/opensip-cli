/**
 * Real-port RSS integration tests. The runner's per-journey RSS is only
 * trustworthy if the PRODUCTION `createMeasuredProcessPort` — not a fake — can
 * actually capture peak resident-set size from a real child and expose it via
 * `rssMeasurement()`. These tests exercise the real port with real children so a
 * regression that silently drops RSS (the "peak RSS is inert" green-wash class)
 * fails here. RSS sampling is POSIX-only, so the availability assertions skip on
 * Windows, where the tagged measurement must be `unavailable`, never `0`.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createMeasuredProcessPort,
  RSS_REASON_CODES,
  runMeasuredCommand,
} from '../lib/measured-process.mjs';

const isPosix = process.platform !== 'win32';
const SIGNAL_CHILD_SOURCE = String.raw`
const { writeFileSync } = require('node:fs');
const signal = process.argv[1];
const marker = process.argv[2];
const exitCode = signal === 'SIGINT' ? 130 : 143;
process.once(signal, () => {
  writeFileSync(marker, signal);
  process.stdout.write('received:' + signal + '\n');
  process.exit(exitCode);
});
process.stdout.write('ready:' + signal + '\n');
setInterval(() => {}, 1000);
`;

function newPort() {
  return createMeasuredProcessPort({ platform: process.platform, bounds: {} });
}

/** A child that allocates a chunk and lives long enough to be sampled. */
function allocSpec(mib, ms) {
  return {
    argv: [
      process.execPath,
      '-e',
      `const b = Buffer.alloc(${mib} * 1024 * 1024); b[0] = 1; setTimeout(() => {}, ${ms});`,
    ],
    cwd: process.cwd(),
    timeoutMs: 10_000,
    rssSampleIntervalMs: 25,
  };
}

test('a real port reports rss-not-sampled before any child runs', () => {
  const port = newPort();
  const rss = port.rssMeasurement();
  assert.equal(rss.status, 'unavailable');
  assert.equal(rss.reasonCode, RSS_REASON_CODES.NOT_SAMPLED);
});

test('the production port captures a real peak RSS from a real child (POSIX)', async () => {
  if (!isPosix) {
    return; // RSS sampling is unsupported on Windows; covered by the negative case below.
  }
  const port = newPort();
  const result = await port.run(allocSpec(8, 400));
  assert.equal(result.status, 0, 'child should exit 0');
  // The run's own tagged RSS is available with a positive peak — never a bare 0.
  assert.equal(result.rss.status, 'available');
  assert.ok(result.rss.peakBytes > 0, 'per-run peakBytes must be > 0');
  // The port accumulates it and exposes the same measurement.
  const measured = port.rssMeasurement();
  assert.equal(measured.status, 'available');
  assert.equal(measured.peakBytes, result.rss.peakBytes);
});

test('the port accumulates the PEAK across multiple children (POSIX)', async () => {
  if (!isPosix) return;
  const port = newPort();
  await port.run(allocSpec(4, 300));
  const small = port.rssMeasurement();
  assert.equal(small.status, 'available');
  await port.run(allocSpec(48, 400));
  const peak = port.rssMeasurement();
  assert.equal(peak.status, 'available');
  assert.ok(peak.peakBytes >= small.peakBytes, 'accumulated peak must not shrink');
});

test('stderr diagnostic retention is separate from the configured stream byte bound', async () => {
  const limit = 256 * 1024;
  const port = createMeasuredProcessPort({
    platform: process.platform,
    bounds: { maxStderrBytes: limit, maxDiagnosticTailBytes: 4096 },
  });
  const withinBound = await port.run({
    argv: [process.execPath, '-e', "process.stderr.write('x'.repeat(8192))"],
    cwd: process.cwd(),
    timeoutMs: 5000,
  });
  assert.equal(withinBound.outputTruncated, false);
  assert.ok(Buffer.byteLength(withinBound.stderrTail) <= 4096);

  const overflow = await port.run({
    argv: [process.execPath, '-e', `process.stderr.write('x'.repeat(${limit + 1}))`],
    cwd: process.cwd(),
    timeoutMs: 5000,
  });
  assert.equal(overflow.outputTruncated, true);
  assert.ok(Buffer.byteLength(overflow.stderrTail) <= 4096);
});

test('Windows reports RSS as unavailable, never a bare zero', async () => {
  // Force the win32 branch of the port regardless of the host so the tagged
  // measurement is proven unavailable (not peakBytes:0) on the unsupported OS.
  const port = createMeasuredProcessPort({ platform: 'win32', bounds: {} });
  const result = await port.run({
    argv: [process.execPath, '-e', 'setTimeout(() => {}, 100);'],
    cwd: process.cwd(),
    timeoutMs: 10_000,
    rssSampleIntervalMs: 25,
  });
  assert.equal(result.rss.status, 'unavailable');
  assert.equal(result.rss.reasonCode, RSS_REASON_CODES.UNSUPPORTED_PLATFORM);
  assert.equal(port.rssMeasurement().status, 'unavailable');
});

test('a malformed final process table cannot report retained descendants as clean', async () => {
  // eslint-disable-next-line unicorn/prefer-event-target -- child-process test doubles expose EventEmitter seams.
  const child = new EventEmitter();
  // eslint-disable-next-line unicorn/prefer-event-target -- child stdout is an EventEmitter stream seam.
  child.stdout = new EventEmitter();
  // eslint-disable-next-line unicorn/prefer-event-target -- child stderr is an EventEmitter stream seam.
  child.stderr = new EventEmitter();
  child.stdout.destroy = () => {
    /* synthetic stream has no native resource */
  };
  child.stderr.destroy = () => {
    /* synthetic stream has no native resource */
  };
  child.pid = 81_234;
  child.kill = () => true;

  let samples = 0;
  const resultPromise = createMeasuredProcessPort({
    platform: 'linux',
    bounds: {},
    deps: {
      captureProcessDescendants: async () => [],
      killProcess: () => {
        /* synthetic PIDs must never reach the host process table */
      },
      readProcessTable: async () => {
        samples += 1;
        if (samples <= 2) {
          return [
            {
              pid: 81_234,
              ppid: 1,
              processGroupId: 81_234,
              sessionToken: '81_234',
              startedAt: 'root-start',
              command: '/usr/bin/node',
              rssBytes: 1024,
            },
            {
              pid: 81_235,
              ppid: 81_234,
              processGroupId: 81_234,
              sessionToken: '81_234',
              startedAt: 'child-start',
              command: '/usr/bin/node',
              rssBytes: 1024,
            },
          ];
        }
        return [{ pid: 'malformed', ppid: 1, rssBytes: 1024 }];
      },
      spawnChild: () => {
        setTimeout(() => child.emit('close', 0, null), 20);
        return child;
      },
      residualSettlementMs: 5,
    },
  }).run({
    argv: ['synthetic-child'],
    cwd: process.cwd(),
    timeoutMs: 1000,
    rssSampleIntervalMs: 500,
  });

  const result = await resultPromise;
  assert.equal(result.status, 0);
  assert.equal(result.cleanup.residualDescendants, 1);
});

test('a root that never emits close is itself reported as residual cleanup state', async () => {
  // eslint-disable-next-line unicorn/prefer-event-target -- child-process test doubles expose EventEmitter seams.
  const child = new EventEmitter();
  // eslint-disable-next-line unicorn/prefer-event-target -- child stdout is an EventEmitter stream seam.
  child.stdout = new EventEmitter();
  // eslint-disable-next-line unicorn/prefer-event-target -- child stderr is an EventEmitter stream seam.
  child.stderr = new EventEmitter();
  child.stdout.destroy = () => {
    /* synthetic stream has no native resource */
  };
  child.stderr.destroy = () => {
    /* synthetic stream has no native resource */
  };
  child.pid = 82_345;
  child.kill = () => true;

  const coordinator = {
    register: () => () => null,
  };
  const result = await runMeasuredCommand({
    command: ['synthetic-nonclosing-child'],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 5,
    terminationGraceMs: 5,
    forceKillSettlementMs: 5,
    sampleIntervalMs: 100,
    stdoutTailBytes: 128,
    stderrTailBytes: 128,
    trackResidualDescendants: true,
    platform: 'linux',
    useProcessGroup: false,
    spawnChild: () => child,
    captureProcessDescendants: async () => [],
    readProcessTable: async () => [
      {
        pid: 82_345,
        ppid: 1,
        processGroupId: 82_345,
        sessionToken: '82_345',
        startedAt: 'root-start',
        command: '/usr/bin/node',
        rssBytes: 1024,
      },
    ],
    parentSignalCoordinator: coordinator,
    rssSampleTimeoutMs: 50,
    residualSettlementMs: 5,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.residualDescendants, 1);
});

test('cleanup waits boundedly for a signalled descendant to leave the process table', async () => {
  // eslint-disable-next-line unicorn/prefer-event-target -- child-process test doubles expose EventEmitter seams.
  const child = new EventEmitter();
  // eslint-disable-next-line unicorn/prefer-event-target -- child stdout is an EventEmitter stream seam.
  child.stdout = new EventEmitter();
  // eslint-disable-next-line unicorn/prefer-event-target -- child stderr is an EventEmitter stream seam.
  child.stderr = new EventEmitter();
  child.stdout.destroy = () => {
    /* synthetic stream has no native resource */
  };
  child.stderr.destroy = () => {
    /* synthetic stream has no native resource */
  };
  child.pid = 83_456;
  child.kill = () => true;

  const root = {
    pid: 83_456,
    ppid: 1,
    processGroupId: 83_456,
    sessionToken: '83_456',
    startedAt: 'root-start',
    command: '/usr/bin/node',
    rssBytes: 1024,
  };
  const descendant = {
    pid: 83_457,
    ppid: root.pid,
    processGroupId: root.processGroupId,
    sessionToken: root.sessionToken,
    startedAt: 'descendant-start',
    command: '/usr/bin/node',
    rssBytes: 1024,
  };
  let signalDelivered = false;
  let postSignalSamples = 0;
  const rows = () => {
    if (!signalDelivered) return [root, descendant];
    postSignalSamples += 1;
    return postSignalSamples < 3 ? [root, descendant] : [root];
  };

  const resultPromise = runMeasuredCommand({
    command: ['synthetic-child'],
    cwd: process.cwd(),
    env: {},
    timeoutMs: 1000,
    sampleIntervalMs: 5,
    stdoutTailBytes: 128,
    stderrTailBytes: 128,
    trackResidualDescendants: true,
    platform: 'linux',
    useProcessGroup: true,
    spawnChild: () => {
      setTimeout(() => child.emit('close', 0, null), 20);
      return child;
    },
    readProcessTable: async () => rows(),
    killProcess: () => {
      signalDelivered = true;
    },
    parentSignalCoordinator: { register: () => () => null },
    rssSampleTimeoutMs: 50,
    residualSettlementMs: 100,
  });

  const result = await resultPromise;
  assert.equal(signalDelivered, true);
  assert.ok(postSignalSamples >= 3);
  assert.equal(result.residualDescendants, 0);
});

test('the production port delivers exact SIGINT/SIGTERM with bounded tree cleanup', async () => {
  if (!isPosix) return;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const pty = signal === 'SIGINT';
    if (pty && !existsSync('/usr/bin/script')) continue;
    const root = mkdtempSync(join(tmpdir(), 'opensip-native-signal-'));
    const marker = join(root, 'received.txt');
    try {
      const timeoutMs = 5000;
      const port = newPort();
      const result = await port.run({
        argv: [process.execPath, '-e', SIGNAL_CHILD_SOURCE, signal, marker],
        cwd: process.cwd(),
        timeoutMs,
        nativeSignal: { signal, afterMs: 150 },
        pty,
        rssSampleIntervalMs: 25,
      });
      assert.equal(
        result.deliveredSignal,
        signal,
        `${signal} was not delivered: ${JSON.stringify({
          status: result.status,
          signal: result.signal,
          durationMs: result.durationMs,
          stdout: result.stdoutCapture,
          stderr: result.stderrTail,
        })}`,
      );
      assert.equal(result.timedOut, false, `${signal} fell through to the timeout`);
      assert.equal(
        result.cancelled,
        false,
        `${signal} was misclassified as AbortSignal cancellation`,
      );
      assert.ok(result.durationMs < timeoutMs, `${signal} did not terminate within the bound`);
      assert.equal(result.cleanup.residualDescendants, 0, `${signal} left a descendant`);
      assert.equal(
        readFileSync(marker, 'utf8'),
        signal,
        `${signal} did not reach the child: ${JSON.stringify({
          status: result.status,
          signal: result.signal,
          durationMs: result.durationMs,
          stdout: result.stdoutCapture,
          stderr: result.stderrTail,
        })}`,
      );
      assert.ok(result.signal !== null || (result.status ?? 0) > 0, `${signal} exited cleanly`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('PTY capture removes only the BSD script EOF artifact and preserves pure JSON', async () => {
  if (!isPosix || !existsSync('/usr/bin/script')) return;
  const result = await newPort().run({
    argv: [process.execPath, '-e', 'process.stdout.write(JSON.stringify({ ok: true }))'],
    cwd: process.cwd(),
    timeoutMs: 5000,
    pty: true,
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdoutCapture), { ok: true });
});
