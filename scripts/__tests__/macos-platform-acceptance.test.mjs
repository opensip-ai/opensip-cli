/**
 * @fileoverview Phase 5 (Task 5.2) — the macOS tuple cross-check DECISION LOGIC.
 *
 * The native macOS journeys (installer/PTY/APFS/SQLite/signals) are gated on the
 * real `process.platform` and are proven on a real Mac by the scheduled/release
 * workflows (Phase 6). What IS host-independent and deterministic on any CI host
 * is the pure cross-check logic the `macos.tuple-crosscheck` journey delegates to:
 * `evaluateTupleCrosscheck`, `buildTupleObservedHost`, and `normalizeUnameArch`.
 *
 * This file exhausts that logic: exact-tuple success, each INDEPENDENT tuple
 * contradiction and each missing required source with its stable reason code, the
 * two selection branches (`tuple-row-unselected` / `tuple-status-unsupported`)
 * driven by injected fake assessors, and the observed-host mapping. It extends —
 * never duplicates — the registry/executor coverage in
 * `platform-acceptance-macos-journeys.test.mjs`.
 *
 * Runs under `node --test` (`pnpm test:scripts`). Pure — no CLI, npm, or network.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildTupleObservedHost,
  evaluateTupleCrosscheck,
  MACOS_PREVIEW_ROW_ID,
  normalizeUnameArch,
} from '../platform-acceptance/journeys/macos.mjs';
import { assessHostSupport } from '../../packages/core/dist/index-lib.js';

/** The exact, fully-observed macOS 26 arm64 tuple sources. */
const OK_TUPLE = Object.freeze({
  swVers: '26.0.1',
  kernelName: 'Darwin',
  kernelRelease: '25.5.0',
  unameMachine: 'arm64',
  npmVersion: '11.0.0',
  nodeArch: 'arm64',
  nodeVersion: 'v24.16.0',
  nodeAbi: '137',
});

// ---------------------------------------------------------------------------
// buildTupleObservedHost — every source maps to its ObservedHost dimension
// ---------------------------------------------------------------------------

test('buildTupleObservedHost maps every present source and pins only process.platform', () => {
  const observed = buildTupleObservedHost(OK_TUPLE);
  assert.deepEqual(observed, {
    osPlatform: 'darwin',
    kernelName: 'Darwin',
    osVersion: '26.0.1',
    kernelRelease: '25.5.0',
    arch: 'arm64',
    nodeVersion: 'v24.16.0',
    nodeAbi: '137',
    npmVersion: '11.0.0',
  });
});

test('buildTupleObservedHost omits every unavailable source (never a guessed value)', () => {
  const observed = buildTupleObservedHost({
    swVers: null,
    kernelName: null,
    kernelRelease: null,
    npmVersion: null,
    nodeArch: null,
    nodeVersion: null,
    nodeAbi: null,
  });
  // Only the process-platform identity remains; nothing is fabricated.
  assert.deepEqual(observed, { osPlatform: 'darwin' });
});

// ---------------------------------------------------------------------------
// normalizeUnameArch — the full folding table
// ---------------------------------------------------------------------------

test('normalizeUnameArch folds every known machine string and passes unknowns through', () => {
  assert.equal(normalizeUnameArch('i686'), 'ia32');
  assert.equal(normalizeUnameArch('AMD64'), 'x64');
  assert.equal(normalizeUnameArch('aarch64'), 'arm64');
  // An unknown token is lower-cased + trimmed but otherwise passed through.
  assert.equal(normalizeUnameArch(' RISCV64 '), 'riscv64');
  // Nullish inputs never throw.
  assert.equal(normalizeUnameArch(null), '');
  assert.equal(normalizeUnameArch(), '');
});

// ---------------------------------------------------------------------------
// evaluateTupleCrosscheck — real core policy, exhaustive matrix
// ---------------------------------------------------------------------------

test('a fully consistent macOS 26 tuple passes and reports the selected preview row', () => {
  const verdict = evaluateTupleCrosscheck(OK_TUPLE, assessHostSupport);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.equal(verdict.reasonCode, null);
  assert.ok(
    verdict.lines.some((line) => line.includes(`${MACOS_PREVIEW_ROW_ID} (preview)`)),
    `expected a selected-row line, got ${JSON.stringify(verdict.lines)}`,
  );
});

test('each independent tuple contradiction fails as tuple-not-supported-row', () => {
  for (const patch of [
    { kernelName: 'Linux' }, // wrong kernel identity
    { kernelRelease: '24.0.0' }, // wrong Darwin kernel major
    { nodeAbi: '127' }, // wrong Node module ABI
    { npmVersion: '10.9.0' }, // wrong npm major
    { swVers: '15.0.0' }, // wrong macOS product version
  ]) {
    const verdict = evaluateTupleCrosscheck({ ...OK_TUPLE, ...patch }, assessHostSupport);
    assert.equal(verdict.ok, false, JSON.stringify(patch));
    assert.equal(verdict.reasonCode, 'tuple-not-supported-row', JSON.stringify(patch));
    assert.ok(verdict.lines.some((line) => line.startsWith('contradictions: ')));
  }
});

test('each missing required source fails as tuple-source-unavailable and names the gap', () => {
  for (const [patch, missing] of [
    [{ swVers: null }, 'sw_vers'],
    [{ kernelName: null }, 'uname-s'],
    [{ kernelRelease: null }, 'uname-r'],
    [{ unameMachine: null }, 'uname-m'],
    [{ npmVersion: null }, 'npm'],
  ]) {
    const verdict = evaluateTupleCrosscheck({ ...OK_TUPLE, ...patch }, assessHostSupport);
    assert.equal(verdict.ok, false, missing);
    assert.equal(verdict.reasonCode, 'tuple-source-unavailable', missing);
    assert.ok(
      verdict.lines.some((line) => line.includes(`missing sources: ${missing}`)),
      `expected the missing source ${missing} to be named: ${JSON.stringify(verdict.lines)}`,
    );
  }
});

test('two disagreeing arch sources fail even when the Node arch alone would match', () => {
  const verdict = evaluateTupleCrosscheck(
    { ...OK_TUPLE, unameMachine: 'x86_64' },
    assessHostSupport,
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reasonCode, 'arch-source-mismatch');
});

// ---------------------------------------------------------------------------
// evaluateTupleCrosscheck — selection branches via injected fake assessors.
// These branches are unreachable through the real registry (a clean tuple always
// selects the preview row), so they are proven with deterministic stub policies.
// ---------------------------------------------------------------------------

test('a clean tuple that selects a DIFFERENT row fails as tuple-row-unselected', () => {
  const stub = () => ({ row: { id: 'some-other-row' }, status: 'preview', reasonCodes: [] });
  const verdict = evaluateTupleCrosscheck(OK_TUPLE, stub);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reasonCode, 'tuple-row-unselected');
});

test('a clean tuple that selects NO row fails as tuple-row-unselected', () => {
  const stub = () => ({ row: null, status: 'unqualified', reasonCodes: [] });
  const verdict = evaluateTupleCrosscheck(OK_TUPLE, stub);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reasonCode, 'tuple-row-unselected');
});

test('the correct row with a non-preview/supported status fails as tuple-status-unsupported', () => {
  const stub = () => ({
    row: { id: MACOS_PREVIEW_ROW_ID },
    status: 'unqualified',
    reasonCodes: [],
  });
  const verdict = evaluateTupleCrosscheck(OK_TUPLE, stub);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reasonCode, 'tuple-status-unsupported');
  assert.ok(verdict.lines.some((line) => line.includes('row status: unqualified')));
});

test('a supported (post burn-in) status on the correct row is accepted', () => {
  const stub = () => ({
    row: { id: MACOS_PREVIEW_ROW_ID },
    status: 'supported',
    reasonCodes: [],
  });
  const verdict = evaluateTupleCrosscheck(OK_TUPLE, stub);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reasonCode, null);
});
