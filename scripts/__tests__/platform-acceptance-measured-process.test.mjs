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
import { test } from 'node:test';

import { createMeasuredProcessPort, RSS_REASON_CODES } from '../lib/measured-process.mjs';

const isPosix = process.platform !== 'win32';

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
