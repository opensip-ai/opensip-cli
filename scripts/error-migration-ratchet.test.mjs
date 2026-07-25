/**
 * @fileoverview Plan 01 Task A.4 — tests for the migration-lane ratchet.
 *
 * The ratchet's whole job is to fail on net-new debt and on nothing else, so the tests
 * pin exactly that: added fails, resolved does not, unchanged is silent, and a signal
 * that carries no fingerprint is surfaced rather than quietly dropped from the count.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { diffFingerprints, fingerprintsFrom } from './error-migration-ratchet.mjs';

test('a new fingerprint is reported as added', () => {
  const d = diffFingerprints(['a', 'b'], ['a', 'b', 'c']);
  assert.deepEqual(d.added, ['c']);
  assert.deepEqual(d.resolved, []);
  assert.equal(d.unchanged, 2);
});

test('a fixed site is reported as resolved, never as a failure', () => {
  const d = diffFingerprints(['a', 'b'], ['a']);
  assert.deepEqual(d.added, [], 'burning down debt must never fail the ratchet');
  assert.deepEqual(d.resolved, ['b']);
});

test('an unchanged backlog produces neither added nor resolved', () => {
  const d = diffFingerprints(['a', 'b'], ['b', 'a']);
  assert.deepEqual(d.added, []);
  assert.deepEqual(d.resolved, []);
  assert.equal(d.unchanged, 2);
});

test('added and resolved are both reported in the same run', () => {
  const d = diffFingerprints(['a', 'b'], ['b', 'c']);
  assert.deepEqual(d.added, ['c']);
  assert.deepEqual(d.resolved, ['a']);
});

test('output is order-independent and deduplicated', () => {
  const d = diffFingerprints(['b', 'a', 'a'], ['a', 'c', 'c', 'b']);
  assert.deepEqual(d.added, ['c'], 'duplicates must not inflate the added set');
});

test('fingerprintsFrom reads the envelope and dedupes', () => {
  const raw = JSON.stringify({
    envelope: {
      signals: [
        { fingerprint: 'f1', ruleId: 'r', filePath: 'a.ts', line: 1 },
        { fingerprint: 'f1', ruleId: 'r', filePath: 'a.ts', line: 1 },
        { fingerprint: 'f2', ruleId: 'r', filePath: 'b.ts', line: 2 },
      ],
    },
  });
  const r = fingerprintsFrom(raw);
  assert.deepEqual(r.fingerprints, ['f1', 'f2']);
  assert.equal(r.unfingerprinted, 0);
});

test('a signal with no fingerprint is counted, not silently dropped', () => {
  // An unratchetable signal must be visible: silently excluding it would let a whole
  // class of finding bypass the gate.
  const raw = JSON.stringify({
    envelope: { signals: [{ fingerprint: 'f1' }, { ruleId: 'r', filePath: 'x.ts' }] },
  });
  const r = fingerprintsFrom(raw);
  assert.deepEqual(r.fingerprints, ['f1']);
  assert.equal(r.unfingerprinted, 1);
});

test('a bare envelope (no CommandOutcome wrapper) is accepted', () => {
  const r = fingerprintsFrom(JSON.stringify({ signals: [{ fingerprint: 'z' }] }));
  assert.deepEqual(r.fingerprints, ['z']);
});
